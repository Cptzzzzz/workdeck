import { test, expect } from "@playwright/test";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
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
test("create files and folders without overwriting and recover a lost confirmation", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "create-ui-"));
  let id = "",
    csrf = "";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    class Instrumented extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/api/workspaces/"))
          Object.defineProperty(this, "onmessage", {
            set: (handler: (event: MessageEvent) => void) =>
              this.addEventListener("message", (event) => {
                if (typeof event.data === "string") {
                  try {
                    const message = JSON.parse(event.data);
                    if (
                      (window as any).dropDirectoryConfirmation &&
                      message.payload?.result?.kind === "directory.create" &&
                      message.payload.result.state === "committed"
                    ) {
                      (window as any).dropDirectoryConfirmation = false;
                      this.close();
                      return;
                    }
                  } catch {}
                }
                handler(event);
              }),
          });
      }
    }
    window.WebSocket = Instrumented;
  });
  const name = `create fixture ${Date.now()}`;
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
      async ({ name, dir, nodeName }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json()),
          nodes = state.nodes.filter(
            (n: any) => n.name === nodeName && n.online,
          );
        if (nodes.length !== 1) throw new Error("fixture node unavailable");
        const r = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!r.ok) throw new Error(`create ${r.status}`);
        return { terminal: await r.json(), csrf: me.csrf };
      },
      { name, dir, nodeName },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    expect(fixture.terminal.state).toBe("running");
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
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await page.getByRole("button", { name: "工作区模式" }).click();
    const add = page.getByRole("button", { name: "新建文件或文件夹" });
    await expect(add).toBeEnabled();
    const create = async (kind: "文件" | "文件夹", item: string) => {
      await add.click();
      const dialog = page.getByRole("dialog", { name: "新建文件或文件夹" });
      await dialog.getByLabel("创建类型").selectOption({ label: kind });
      await dialog.getByLabel("文件名称").fill(item);
      await dialog.getByRole("button", { name: "创建", exact: true }).click();
      return dialog;
    };
    let dialog = await create("文件夹", "project");
    await expect(dialog).toBeHidden();
    expect(existsSync(path.join(dir, "project"))).toBe(true);
    await page.getByRole("button", { name: "project", exact: true }).click();
    dialog = await create("文件", "notes.txt");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "notes.txt", exact: true }),
    ).toBeVisible();
    writeFileSync(path.join(dir, "project", "notes.txt"), "existing content");
    dialog = await create("文件", "notes.txt");
    await expect(dialog.getByRole("alert")).toContainText("已存在");
    expect(readFileSync(path.join(dir, "project", "notes.txt"), "utf8")).toBe(
      "existing content",
    );
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.evaluate(() => {
      (window as any).dropDirectoryConfirmation = true;
    });
    dialog = await create("文件夹", "lost-confirmation");
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(existsSync(path.join(dir, "project", "lost-confirmation"))).toBe(
      true,
    );
    await expect(page.locator(".workbench-route")).toContainText("中转连接");
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("已有待确认");
    expect(existsSync(path.join(dir, "lost-confirmation"))).toBe(false);
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.getByText("待确认的创建操作")).toBeVisible();
    const pending = page
      .locator(".workbench-intents")
      .filter({ hasText: "project/lost-confirmation" });
    await expect(
      pending.getByRole("button", { name: "核对并继续" }),
    ).toBeEnabled();
    await pending.getByRole("button", { name: "核对并继续" }).click();
    await expect(page.getByText("待确认的创建操作")).toBeHidden();
    expect(
      readdirSync(path.join(dir, "project")).filter(
        (n) => n === "lost-confirmation",
      ),
    ).toHaveLength(1);
    expect(pane()).toBe(pid);
    expect(errors).toEqual([]);
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
