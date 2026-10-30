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

test("closing documents handles drafts and pending saves without stopping terminals", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "close-ui-")),
    name = `close fixture ${Date.now()}`;
  writeFileSync(path.join(dir, "one.txt"), "first\n");
  writeFileSync(path.join(dir, "two.txt"), "second\n");
  writeFileSync(
    path.join(dir, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1kAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: any) {
        if (
          typeof data === "string" &&
          this.url.includes("/api/workspaces/") &&
          (window as any).__dropCommit &&
          JSON.parse(data).type === "file.write.commit"
        ) {
          (window as any).__dropCommit = false;
          this.close();
          return;
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
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await page.getByRole("button", { name: "two.txt", exact: true }).click();
    await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
    await expect(
      page.getByRole("button", { name: "关闭文件 one.txt" }),
    ).toHaveCount(0);
    await expect(page.locator(".workbench-editor-toolbar")).toContainText(
      "two.txt",
    );
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    const editor = page.locator(".monaco-editor textarea.inputarea"),
      screen = page.locator(".monaco-editor .view-lines");
    await expect(screen).toContainText("first");
    const replace = async (text: string) => {
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(text);
    };
    await replace("local one\n");
    await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
    let dialog = page.getByRole("dialog", { name: "关闭文件" });
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(screen).toContainText("local one");
    await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
    await dialog.getByRole("button", { name: "保留草稿并关闭" }).click();
    await expect(
      page.getByRole("button", { name: "关闭文件 one.txt" }),
    ).toHaveCount(0);
    const drafts = page
      .locator(".workbench-intents")
      .filter({ hasText: "本地未保存草稿" });
    await drafts
      .locator("div")
      .filter({ hasText: "one.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(screen).toContainText("local one");
    await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
    await dialog.getByRole("button", { name: "放弃修改" }).click();
    expect(readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("first\n");
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await expect(screen).toContainText("first");
    await replace("saved one\n");
    await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
    await dialog.getByRole("button", { name: "保存并关闭" }).click();
    await expect(
      page.getByRole("button", { name: "关闭文件 one.txt" }),
    ).toHaveCount(0);
    expect(readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("saved one\n");
    await page.getByRole("button", { name: "one.txt", exact: true }).click();
    await expect(page.locator(".workbench-editor-toolbar")).toContainText(
      "one.txt",
    );
    await expect(screen).toContainText("saved one");
    await replace("first tab draft\n");
    await page.waitForTimeout(700);
    const other = await page.context().newPage();
    try {
      await other.goto("/?transport=relay");
      await other.getByRole("button", { name, exact: true }).click();
      await other.getByRole("button", { name: "one.txt", exact: true }).click();
      const otherEditor = other.locator(".monaco-editor textarea.inputarea");
      await expect(otherEditor).toBeAttached();
      await otherEditor.focus();
      await other.keyboard.press("ControlOrMeta+A");
      await other.keyboard.insertText("other tab draft\n");
      await other.waitForTimeout(800);
      await page.getByRole("button", { name: "关闭文件 one.txt" }).click();
      await dialog.getByRole("button", { name: "放弃修改" }).click();
      await expect(dialog.getByRole("alert")).toContainText(
        "此草稿已在另一个标签页更改",
      );
      await dialog.getByRole("button", { name: "取消" }).click();
      await expect(screen).toContainText("first tab draft");
      expect(readFileSync(path.join(dir, "one.txt"), "utf8")).toBe(
        "saved one\n",
      );
    } finally {
      await other.close();
    }
    await page.getByRole("button", { name: "image.png", exact: true }).click();
    await page.getByRole("button", { name: "关闭文件 image.png" }).click();
    await expect(
      page.getByRole("button", { name: "关闭文件 image.png" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "two.txt", exact: true })
      .last()
      .click();
    await expect(screen).toContainText("second");
    await replace("pending two\n");
    await page.evaluate(() => {
      (window as any).__dropCommit = true;
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "关闭文件 two.txt" }).click();
    dialog = page.getByRole("dialog", { name: "关闭文件" });
    await expect(
      dialog.getByRole("button", { name: "放弃修改" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "保留草稿并关闭" }).click();
    await drafts
      .locator("div")
      .filter({ hasText: "two.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(screen).toContainText("pending two");
    await page.getByRole("button", { name: "核对保存状态" }).click();
    await page.getByRole("button", { name: "取消未完成保存" }).click();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "关闭文件 two.txt" }).click();
    await page.evaluate(() => {
      (window as any).__dropCommit = true;
    });
    await dialog.getByRole("button", { name: "保存并关闭" }).click();
    await expect(dialog.getByRole("alert")).toContainText("保存结果尚未确认");
    await dialog.getByRole("button", { name: "保留草稿并关闭" }).click();
    await drafts
      .locator("div")
      .filter({ hasText: "two.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "核对保存状态" }).click();
    await page.getByRole("button", { name: "取消未完成保存" }).click();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toHaveCount(0);
    expect(readFileSync(path.join(dir, "two.txt"), "utf8")).toBe("second\n");
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
