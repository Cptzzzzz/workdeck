import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);
test("offline tree and drafts survive reconnect and reconcile safely", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "watch-ui-")),
    name = `watch fixture ${Date.now()}`;
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "one.txt"), "original\n");
  writeFileSync(path.join(dir, "sub", "two.txt"), "other\n");
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      (window as any).__fileSockets = new Set<WebSocket>();
      (window as any).__watchPolls = 0;
      (window as any).__watchOpens = 0;
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: any) {
        if (this.url.includes("/api/workspaces/"))
          (window as any).__fileSockets.add(this);
        if (typeof data === "string" && this.url.includes("/api/workspaces/")) {
          try {
            const type = JSON.parse(data).type;
            if (type === "watch.poll") (window as any).__watchPolls++;
            if (type === "watch.open") (window as any).__watchOpens++;
          } catch {}
        }
        return original.call(this, data);
      };
    });
    await page.goto("/?transport=relay");
    await page.getByLabel("用户名").fill("admin");
    await page
      .getByLabel("密码", { exact: true })
      .fill(
        readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE!, "utf8").trim(),
      );
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    const fixture = await page.evaluate(
      async ({ nodeName, dir, name }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) =>
            n.name === nodeName &&
            n.online &&
            n.capabilities?.includes("workspace-watch-v1"),
        );
        if (nodes.length !== 1)
          throw new Error("isolated watch-capable node unavailable");
        const r = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!r.ok) throw new Error(`fixture ${r.status}`);
        return { terminal: await r.json(), csrf: me.csrf };
      },
      { nodeName, dir, name },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    const pane = () =>
      execFileSync(
        "tmux",
        [
          "-L",
          `workdeck-${id}`,
          "display-message",
          "-p",
          "-t",
          "main",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim();
    const pid = pane();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "sub", exact: true }).click();
    const filter = page.getByLabel(/筛选所选目录/);
    await filter.fill("one");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "two.txt", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    const screen = page.locator(".monaco-editor .view-lines");
    await expect(screen).toContainText("original");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("unsaved local draft");
    await page.getByRole("button", { name: "终端模式" }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page.getByRole("button", { name: "one.txt", exact: true }),
    ).toBeVisible();
    await expect(filter).toHaveValue("one");
    await expect(screen).toContainText("unsaved local draft");
    await page.route("**/api/workspaces/*/connections", (route) =>
      route.abort(),
    );
    await page.evaluate(() => {
      for (const socket of (window as any).__fileSockets) socket.close();
    });
    await expect(
      page.getByText(/文件连接不可用，以下是上次读取的目录/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "one.txt", exact: true }),
    ).toBeDisabled();
    await page.waitForTimeout(4200);
    await expect(
      page.getByRole("button", { name: "one.txt", exact: true }),
    ).toBeVisible();
    await expect(screen).toContainText("unsaved local draft");
    expect(pane()).toBe(pid);
    writeFileSync(
      path.join(dir, "sub", "one-new.txt"),
      "created while offline",
    );
    writeFileSync(path.join(dir, "sub", "one.txt"), "external change");
    await page.unroute("**/api/workspaces/*/connections");
    await expect(
      page.getByRole("button", { name: "one-new.txt", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(filter).toHaveValue("one");
    await expect(
      page.getByRole("button", { name: "two.txt", exact: true }),
    ).toHaveCount(0);
    await expect(screen).toContainText("unsaved local draft");
    await expect(
      page
        .locator(".workbench-notice")
        .filter({ hasText: "远端文件已改变，本地草稿已保留" }),
    ).toBeVisible();
    expect(readFileSync(path.join(dir, "sub", "one.txt"), "utf8")).toBe(
      "external change",
    );
    expect(pane()).toBe(pid);
  } finally {
    if (id && csrf)
      await page.request
        .delete(`/api/terminals/${id}`, {
          headers: { "X-Workdeck-CSRF": csrf },
        })
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
