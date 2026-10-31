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
test("large text preview reads bounded pages and preserves the terminal", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "watch-ui-")),
    name = `watch fixture ${Date.now()}`;
  const large = Buffer.alloc(5 * 1024 * 1024 + 256, 0x61);
  for (let i = 79; i < large.length; i += 80) large[i] = 10;
  Buffer.from("😀").copy(large, 256 * 1024 - 1);
  Buffer.from("TAIL_MARKER").copy(large, large.length - 11);
  writeFileSync(path.join(dir, "large.txt"), large);
  writeFileSync(
    path.join(dir, "binary.log"),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  );
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      (window as any).__watchPolls = 0;
      (window as any).__watchOpens = 0;
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: any) {
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
    const direct = process.env.WORKDECK_PREVIEW_DIRECT === "1";
    await page.goto(direct ? "/?file_transport=direct" : "/?transport=relay");
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
    if (direct)
      await expect(page.locator(".workbench-route")).toContainText(
        "WebRTC 直连",
        { timeout: 30000 },
      );
    await page.getByRole("button", { name: "large.txt", exact: true }).click();
    await expect(page.getByText(/仅提供只读分段预览/)).toBeVisible();
    const body = page.locator(".large-text-content");
    await expect(body).toBeVisible();
    expect((await body.textContent())?.endsWith("😀")).toBe(true);
    await page.getByRole("button", { name: "下一段" }).click();
    await expect(body).toBeVisible();
    expect((await body.textContent())?.startsWith("a")).toBe(true);
    expect((await body.textContent())?.includes("�")).toBe(false);
    await page.getByLabel("段", { exact: true }).fill("21");
    await page.getByRole("button", { name: "跳转" }).click();
    await expect(body).toContainText("TAIL_MARKER");
    expect(
      await page.getByRole("button", { name: "下载文件" }).isEnabled(),
    ).toBe(true);
    writeFileSync(
      path.join(dir, "large.txt"),
      Buffer.alloc(5 * 1024 * 1024 + 256, 0x62),
    );
    await page.getByRole("button", { name: "上一段" }).click();
    await expect(
      page.locator(".large-text-preview").getByRole("alert"),
    ).toBeVisible();
    writeFileSync(path.join(dir, "large.txt"), "small replacement\n");
    await page
      .locator(".file-tree-row")
      .filter({ hasText: "large.txt" })
      .click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "small replacement",
    );
    await page.getByRole("button", { name: "binary.log", exact: true }).click();
    await expect(
      page.locator(".large-text-preview").getByRole("alert"),
    ).toContainText("不是可预览的 UTF-8 文本");
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
