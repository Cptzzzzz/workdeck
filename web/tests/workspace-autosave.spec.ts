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

test("automatic save is opt-in and stops on external conflict", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "autosave-ui-")),
    file = path.join(dir, "example.txt"),
    name = `autosave fixture ${Date.now()}`;
  writeFileSync(file, "initial\n");
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      const Original = window.WebSocket;
      (window as any).__fileSockets = [];
      class ObservedSocket extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/api/workspaces/"))
            (window as any).__fileSockets.push(this);
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (
            typeof data === "string" &&
            (window as any).__delayNextCommit &&
            JSON.parse(data).type === "file.write.commit"
          ) {
            (window as any).__delayNextCommit = false;
            window.setTimeout(() => super.send(data), 1800);
          } else super.send(data);
        }
      }
      window.WebSocket = ObservedSocket;
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
        { encoding: "utf8" },
      ).trim();
    const pid = pane();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await expect(editor).toBeAttached();
    const replace = async (text: string) => {
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(text);
    };
    await replace("manual draft\n");
    await page.waitForTimeout(2000);
    expect(readFileSync(file, "utf8")).toBe("initial\n");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" }),
      toggle = settings.getByLabel("停止输入后自动保存文件");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await settings.getByRole("button", { name: "关闭对话框" }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toBe("manual draft\n");
    await page.evaluate(() => {
      (window as any).__delayNextCommit = true;
    });
    await replace("first snapshot\n");
    await expect(page.getByRole("button", { name: "保存中…" })).toBeVisible();
    await replace("newer edit\n");
    await expect
      .poll(() => readFileSync(file, "utf8"), { timeout: 15000 })
      .toBe("newer edit\n");
    await page.evaluate(() => (window as any).__fileSockets.at(-1).close());
    await expect(page.getByText("文件连接已断开，正在尝试恢复")).toBeVisible();
    await replace("offline draft\n");
    await page.waitForTimeout(1800);
    expect(readFileSync(file, "utf8")).toBe("newer edit\n");
    await expect
      .poll(() => readFileSync(file, "utf8"), { timeout: 15000 })
      .toBe("offline draft\n");
    await replace("local draft\n");
    writeFileSync(file, "external change\n");
    await expect(
      page
        .locator(".workbench-notice")
        .filter({ hasText: "远端文件已改变，本地草稿已保留" }),
    ).toBeVisible();
    await page.waitForTimeout(2000);
    expect(readFileSync(file, "utf8")).toBe("external change\n");
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "设置" })
        .getByLabel("停止输入后自动保存文件"),
    ).toBeChecked();
    await page.getByRole("button", { name: "关闭对话框" }).click();
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
