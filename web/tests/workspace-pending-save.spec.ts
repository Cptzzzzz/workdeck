import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
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

test("pending saves are reconciled without replay or losing drafts", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "pending-save-ui-")),
    file = path.join(dir, "example.txt"),
    name = `pending fixture ${Date.now()}`;
  writeFileSync(file, "original\n");
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
            this.url.includes("/api/workspaces/")
          ) {
            const msg = JSON.parse(data);
            if (
              msg.type === "file.write.commit" &&
              (window as any).__commitFault
            ) {
              const mode = (window as any).__commitFault;
              (window as any).__commitFault = "";
              if (mode === "before") {
                this.close();
                return;
              }
              if (mode === "after") {
                const prior = this.onmessage;
                this.onmessage = (event) => {
                  if (
                    typeof event.data === "string" &&
                    JSON.parse(event.data).request_id === msg.request_id
                  ) {
                    this.close();
                    return;
                  }
                  prior?.call(this, event);
                };
              }
            }
          }
          super.send(data);
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
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    const editor = page.locator(".monaco-editor textarea.inputarea"),
      screen = page.locator(".monaco-editor .view-lines");
    await expect(editor).toBeAttached();
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("draft one\n");
    await page.evaluate(() => {
      (window as any).__commitFault = "before";
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "核对保存状态" }).click();
    await expect(page.getByText(/保存尚未提交，节点已确认/)).toBeVisible();
    await page.getByRole("button", { name: "取消未完成保存" }).click();
    await expect(
      page.getByText("未完成的保存已取消，本地草稿仍保留。", { exact: true }),
    ).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe("original\n");
    await expect(screen).toContainText("draft one");
    await page.evaluate(() => {
      (window as any).__commitFault = "after";
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toBe("draft one\n");
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "核对保存状态" }).click();
    await expect(
      page.getByText("已确认保存；之后的编辑仍保留。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toHaveCount(0);
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("draft two\n");
    await page.evaluate(() => {
      (window as any).__commitFault = "after";
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toBe("draft two\n");
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toBeEnabled({ timeout: 15000 });
    unlinkSync(file);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    const draftList = page
      .locator(".workbench-intents")
      .filter({ hasText: "本地未保存草稿" });
    await draftList
      .locator("div")
      .filter({ hasText: "example.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(screen).toContainText("draft two");
    await page.getByRole("button", { name: "核对保存状态" }).click();
    await expect(
      page.getByText(
        "已确认先前保存，但当前文件已变化或不可访问，请先处理草稿。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "另存为新文件" }).click();
    const saveAs = page.getByRole("dialog", { name: "另存不可访问的草稿" });
    await saveAs.getByLabel("另存文件名").fill("recovered.txt");
    await saveAs.getByRole("button", { name: "另存", exact: true }).click();
    await expect
      .poll(() => {
        try {
          return readFileSync(path.join(dir, "recovered.txt"), "utf8");
        } catch {
          return "";
        }
      })
      .toBe("draft two\n");
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
