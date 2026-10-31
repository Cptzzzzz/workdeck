import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);

test("closed terminal workspace remains accessible without restarting the shell", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "management-ui-"));
  const name = `closed workspace fixture ${Date.now()}`;
  writeFileSync(path.join(dir, "note.txt"), "original\n");
  let id = "",
    csrf = "";
  try {
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
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("isolated node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`fixture ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
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
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    const pid = pane();
    expect(Number(pid)).toBeGreaterThan(0);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "note.txt", exact: true }).click();
    const screen = page.locator(".monaco-editor .view-lines");
    await expect(screen).toContainText("original");
    await page.locator(".monaco-editor textarea.inputarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("draft survives closure");
    await page.getByRole("button", { name: "会话管理" }).click();
    let dialog = page.getByRole("dialog", { name: "会话管理" });
    await dialog.getByLabel("搜索会话").fill(name);
    await dialog.getByRole("button", { name: "终止", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "终止终端" });
    await confirmation
      .getByRole("button", { name: "终止终端", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect
      .poll(async () =>
        page.evaluate(async (id) => {
          const state = await fetch("/api/state").then((r) => r.json());
          return state.terminals.find((t: any) => t.id === id)?.state;
        }, id),
      )
      .toBe("closed");
    dialog = page.getByRole("dialog", { name: "会话管理" });
    await dialog.getByLabel("显示已终止").check();
    await dialog.getByLabel("搜索会话").fill(name);
    await dialog.getByRole("button", { name: "查看文件" }).click();
    await expect(
      page.getByRole("button", { name: "note.txt", exact: true }),
    ).toBeVisible();
    await expect(screen).toContainText("draft survives closure");
    await page.reload();
    await page.getByRole("button", { name: "会话管理" }).click();
    dialog = page.getByRole("dialog", { name: "会话管理" });
    await dialog.getByLabel("显示已终止").check();
    await dialog.getByLabel("搜索会话").fill(name);
    await dialog.getByRole("button", { name: "查看文件" }).click();
    await expect(screen).toContainText("draft survives closure");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "note.txt"), "utf8"))
      .toBe("draft survives closure");
    expect(() => pane()).toThrow();
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
