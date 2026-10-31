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
test("directory filtering and incremental rendering preserve the running terminal", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "watch-ui-")),
    name = `watch fixture ${Date.now()}`;
  mkdirSync(path.join(dir, "sub"));
  mkdirSync(path.join(dir, "__proto__"));
  writeFileSync(path.join(dir, "__proto__", "safe.txt"), "");
  mkdirSync(path.join(dir, ".config"));
  writeFileSync(path.join(dir, ".config", "settings.json"), "{}");
  writeFileSync(path.join(dir, ".env"), "secret=example");
  for (let i = 0; i < 205; i++)
    writeFileSync(
      path.join(dir, `entry-${String(i).padStart(3, "0")}.txt`),
      "",
    );
  writeFileSync(path.join(dir, "sub", "needle.txt"), "");
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
    await expect(page.getByRole("button", { name: /显示更多/ })).toBeVisible();
    await page.getByRole("button", { name: /显示更多/ }).click();
    await expect(
      page.getByRole("button", { name: "entry-204.txt", exact: true }),
    ).toBeVisible();
    const input = page.getByLabel(/筛选所选目录/);
    await input.fill("entry-204");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "entry-204.txt", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "entry-000.txt", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page.getByRole("button", { name: "entry-000.txt", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "清除筛选" }).click();
    await page.getByRole("button", { name: "sub", exact: true }).click();
    await input.fill("needle");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "needle.txt", exact: true }),
    ).toBeVisible();
    writeFileSync(path.join(dir, "sub", "needle-new.txt"), "new");
    await expect(
      page.getByRole("button", { name: "needle-new.txt", exact: true }),
    ).toBeVisible({ timeout: 8000 });
    writeFileSync(path.join(dir, "sub", "other.txt"), "new");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page.getByRole("button", { name: "other.txt", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "__proto__", exact: true }).click();
    await input.fill("safe");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "safe.txt", exact: true }),
    ).toBeVisible();
    const hidden = page.getByRole("checkbox", { name: "显示隐藏文件和目录" });
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toHaveCount(0);
    await hidden.check();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toBeVisible();
    await page.locator(".workbench-root").click();
    await input.fill(".env");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: ".config", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "清除筛选" }).click();
    await page.getByRole("button", { name: ".config", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "settings.json", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toBeVisible();
    await hidden.uncheck();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("筛选所选目录：.", { exact: true }),
    ).toBeVisible();
    await hidden.check();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(hidden).toBeChecked();
    await expect(
      page.getByRole("button", { name: ".env", exact: true }),
    ).toBeVisible();
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
