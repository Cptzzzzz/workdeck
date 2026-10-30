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
test("file watcher refreshes expanded directories without disturbing the terminal", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "watch-ui-")),
    name = `watch fixture ${Date.now()}`;
  mkdirSync(path.join(dir, "sub"));
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
    await page.waitForFunction(() => (window as any).__watchPolls >= 1);
    writeFileSync(path.join(dir, "instant.txt"), "new\n");
    await expect(
      page.getByRole("button", { name: "instant.txt", exact: true }),
    ).toBeVisible({ timeout: 4000 });
    const count = await page.evaluate(() => ({
      polls: (window as any).__watchPolls,
      opens: (window as any).__watchOpens,
    }));
    await page.getByRole("button", { name: "sub", exact: true }).click();
    await page.waitForFunction(
      (count) =>
        (window as any).__watchOpens > count.opens &&
        (window as any).__watchPolls > count.polls,
      count,
    );
    writeFileSync(path.join(dir, "sub", "nested.txt"), "new\n");
    await expect(
      page.getByRole("button", { name: "nested.txt", exact: true }),
    ).toBeVisible({ timeout: 4000 });
    await page.getByRole("button", { name: "终端模式" }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    const afterSwitch = await page.evaluate(() => (window as any).__watchPolls);
    await page.waitForFunction(
      (count) => (window as any).__watchPolls > count,
      afterSwitch,
    );
    writeFileSync(path.join(dir, "again.txt"), "again\n");
    await expect(
      page.getByRole("button", { name: "again.txt", exact: true }),
    ).toBeVisible({ timeout: 4000 });
    for (let i = 0; i < 34; i++) {
      const before = await page.evaluate(() => ({
        polls: (window as any).__watchPolls,
        opens: (window as any).__watchOpens,
      }));
      await page.getByRole("button", { name: "终端模式" }).click();
      await page.getByRole("button", { name: "工作区模式" }).click();
      await page.waitForFunction(
        (old) =>
          (window as any).__watchOpens > old.opens &&
          (window as any).__watchPolls > old.polls,
        before,
      );
    }
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
