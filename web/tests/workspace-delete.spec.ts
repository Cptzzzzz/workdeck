import { test, expect } from "@playwright/test";
import {
  existsSync,
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
test("confirmed deletion recovers after disconnect and preserves drafts and later files", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "delete-ui-"));
  mkdirSync(path.join(dir, "project"));
  writeFileSync(path.join(dir, "project", "one.txt"), "original\n");
  writeFileSync(path.join(dir, "project", "two.txt"), "base two\n");
  writeFileSync(path.join(dir, "safe.txt"), "keep\n");
  let id = "",
    csrf = "";
  const name = `delete fixture ${Date.now()}`;
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
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.getByRole("button", { name: "two.txt", exact: true }).click();
    const beforeReload = page.locator(".monaco-editor textarea.inputarea");
    await expect(beforeReload).toBeAttached();
    await beforeReload.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("second draft\n");
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
    await page.keyboard.insertText("draft text\n");
    await page
      .getByRole("button", { name: "删除 project", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "删除文件或文件夹" });
    await expect(dialog).toContainText("递归");
    await dialog.getByRole("button", { name: "检查删除范围" }).click();
    await expect(dialog).toContainText("清单：3 项");
    expect(existsSync(path.join(dir, "project", "one.txt"))).toBe(true);
    writeFileSync(path.join(dir, "project", "late.txt"), "later\n");
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      (window as any).deleteOriginalSend = original;
      WebSocket.prototype.send = function (data: any) {
        let kind = "";
        if (typeof data === "string") {
          try {
            kind = JSON.parse(data).type;
          } catch {}
        }
        if (kind === "entry.delete.commit") {
          original.call(this, data);
          this.close();
          return;
        }
        return original.call(this, data);
      };
    });
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await page.evaluate(() => {
      WebSocket.prototype.send = (window as any).deleteOriginalSend;
    });
    await page.getByRole("button", { name: "关闭对话框" }).click();
    const pending = page
      .locator(".workbench-intents > div")
      .filter({
        hasText: "project",
        has: page.getByRole("button", { name: "核对并继续" }),
      });
    await expect(pending).toBeVisible();
    const retry = pending.getByRole("button", { name: "核对并继续" });
    await expect(retry).toBeEnabled({ timeout: 15000 });
    await retry.click();
    dialog = page.getByRole("dialog", { name: "删除文件或文件夹" });
    await dialog.getByRole("button", { name: "核对删除状态" }).click();
    const resume = dialog.getByRole("button", { name: "继续删除" });
    await expect
      .poll(
        async () =>
          (await resume.isVisible()) ||
          ((await dialog.textContent()) || "").includes("部分项目未删除"),
      )
      .toBe(true);
    if (await resume.isVisible()) await resume.click();
    await expect(dialog).toContainText("部分项目未删除");
    await expect(dialog).toContainText("跳过");
    await dialog.getByRole("button", { name: "已查看结果" }).click();
    await expect(dialog).toBeHidden();
    expect(existsSync(path.join(dir, "project", "one.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "project", "late.txt"), "utf8")).toBe(
      "later\n",
    );
    await expect(page.locator(".monaco-editor")).toContainText("draft text");
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    const draft = page
      .locator(".workbench-intents > div")
      .filter({ hasText: "project/one.txt" });
    await draft.getByRole("button", { name: "打开草稿" }).click();
    await expect(page.locator(".monaco-editor")).toContainText("draft text");
    await page.getByRole("button", { name: "另存为新文件" }).click();
    const saveDialog = page.getByRole("dialog", { name: "另存已删除的草稿" });
    await saveDialog.getByLabel("另存文件名").fill("rescued.txt");
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      (window as any).saveAsOriginalSend = original;
      WebSocket.prototype.send = function (data: any) {
        let kind = "";
        if (typeof data === "string") {
          try {
            kind = JSON.parse(data).type;
          } catch {}
        }
        if (kind === "file.write.commit") {
          original.call(this, data);
          this.close();
          return;
        }
        return original.call(this, data);
      };
    });
    await saveDialog.getByRole("button", { name: "另存", exact: true }).click();
    await expect(saveDialog.getByRole("alert")).toBeVisible();
    await page.evaluate(() => {
      WebSocket.prototype.send = (window as any).saveAsOriginalSend;
    });
    await saveDialog.getByRole("button", { name: "取消" }).click();
    const continueSave = page.getByRole("button", { name: "核对并继续另存" });
    await expect(continueSave).toBeEnabled({ timeout: 15000 });
    await continueSave.click();
    await saveDialog.getByRole("button", { name: "核对并继续" }).click();
    await expect(saveDialog).toBeHidden();
    await expect
      .poll(() => readFileSync(path.join(dir, "rescued.txt"), "utf8"))
      .toBe("draft text\n");
    writeFileSync(path.join(dir, "project", "one.txt"), "new external\n");
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await expect(
      page
        .locator(".workbench-notice")
        .filter({ hasText: "此路径有已删除文件的草稿" }),
    ).toBeVisible();
    await page
      .locator(".workbench-intents > div")
      .filter({ hasText: "project/one.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await page.getByRole("button", { name: "移除本地草稿" }).click();
    const discard = page.getByRole("dialog", { name: "移除本地草稿" });
    await expect(discard).toContainText("未另存或导出的修改会丢失");
    await discard.getByRole("button", { name: "确认移除草稿" }).click();
    await expect(discard).toBeHidden();
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toContainText("new external");
    const secondDraft = page
      .locator(".workbench-intents > div")
      .filter({ hasText: "project/two.txt" });
    await secondDraft.getByRole("button", { name: "打开草稿" }).click();
    await expect(page.locator(".monaco-editor")).toContainText("second draft");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await page
      .getByRole("button", { name: "删除 safe.txt", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "删除文件或文件夹" });
    await dialog.getByRole("button", { name: "检查删除范围" }).click();
    await expect(
      dialog.getByRole("button", { name: "确认删除" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    expect(readFileSync(path.join(dir, "safe.txt"), "utf8")).toBe("keep\n");
    const safePending = page
      .locator(".workbench-intents > div")
      .filter({ hasText: "safe.txt" });
    await safePending.getByRole("button", { name: "核对并继续" }).click();
    dialog = page.getByRole("dialog", { name: "删除文件或文件夹" });
    await dialog.getByRole("button", { name: "核对删除状态" }).click();
    await expect(
      dialog.getByRole("button", { name: "确认删除" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(readFileSync(path.join(dir, "safe.txt"), "utf8")).toBe("keep\n");
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
