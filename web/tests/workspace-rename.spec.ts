import { test, expect } from "@playwright/test";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  testURL = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testURL),
  "requires a dedicated local test node",
);
test("rename preserves dirty editor content and terminal process", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "rename-ui-"));
  mkdirSync(path.join(dir, "project"));
  writeFileSync(path.join(dir, "project", "one.txt"), "base\n");
  writeFileSync(path.join(dir, "project", "two.txt"), "second base\n");
  writeFileSync(path.join(dir, "collision.txt"), "other\n");
  let id = "",
    csrf = "";
  const name = `rename fixture ${Date.now()}`;
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
        const matches = state.nodes.filter(
          (n: any) => n.name === nodeName && n.online,
        );
        if (matches.length !== 1) throw new Error("fixture node unavailable");
        const r = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: matches[0].id, name, cwd: dir }),
        });
        if (!r.ok) throw new Error(`fixture: ${r.status}`);
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
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.getByRole("button", { name: "two.txt", exact: true }).click();
    const firstEditor = page.locator(".monaco-editor textarea.inputarea");
    await expect(firstEditor).toBeAttached();
    await firstEditor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("stored draft\n");
    await page.waitForTimeout(800);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await expect(editor).toBeAttached();
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("unsaved content\n");
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      (window as any).renameOriginalSend = original;
      WebSocket.prototype.send = function (data: any) {
        let kind = "";
        if (typeof data === "string") {
          try {
            kind = JSON.parse(data).type;
          } catch {}
        }
        if (kind === "entry.rename") {
          original.call(this, data);
          this.close();
          return;
        }
        return original.call(this, data);
      };
    });
    await page
      .getByRole("button", { name: "重命名 project", exact: true })
      .click();
    const modal = page.getByRole("dialog", { name: "重命名文件或文件夹" });
    await modal.getByLabel("新的文件名称").fill("renamed");
    await modal.getByRole("button", { name: "重命名", exact: true }).click();
    await expect(modal.getByRole("alert")).toBeVisible();
    await page.evaluate(() => {
      WebSocket.prototype.send = (window as any).renameOriginalSend;
    });
    await modal.getByRole("button", { name: "取消" }).click();
    const pending = page
      .locator(".workbench-intents > div")
      .filter({ hasText: "renamed" });
    await expect(pending).toBeVisible();
    const resume = pending.getByRole("button", { name: "核对并继续" });
    await expect(resume).toBeEnabled({ timeout: 15000 });
    await resume.click();
    await expect(pending).toBeHidden();
    await expect(page.locator(".workbench-editor-toolbar")).toContainText(
      "renamed/one.txt",
    );
    await expect(page.locator(".monaco-editor")).toContainText(
      "unsaved content",
    );
    await page
      .getByRole("button", { name: "重命名 renamed", exact: true })
      .click();
    const conflictModal = page.getByRole("dialog", {
      name: "重命名文件或文件夹",
    });
    await conflictModal.getByLabel("新的文件名称").fill("collision.txt");
    await conflictModal
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await expect(conflictModal.getByRole("alert")).toContainText("目标已存在");
    await conflictModal.getByRole("button", { name: "取消" }).click();
    expect(readFileSync(path.join(dir, "collision.txt"), "utf8")).toBe(
      "other\n",
    );
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "renamed", exact: true }).click();
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toContainText(
      "unsaved content",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "renamed", "one.txt"), "utf8"))
      .toBe("unsaved content\n");
    await page.getByRole("button", { name: "two.txt", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toContainText("stored draft");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "renamed", "two.txt"), "utf8"))
      .toBe("stored draft\n");
    expect(existsSync(path.join(dir, "project"))).toBe(false);
    expect(pane()).toBe(pid);
  } finally {
    if (id)
      await page
        .evaluate(
          async ({ id, csrf }) => {
            await fetch(`/api/terminals/${id}`, {
              method: "DELETE",
              headers: { "X-Workdeck-CSRF": csrf },
            });
          },
          { id, csrf },
        )
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
