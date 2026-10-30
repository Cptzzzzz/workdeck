import { test, expect } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  testURL = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testURL),
  "requires a dedicated local test node",
);
test("modes share the terminal and the workspace edits and saves files", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "workbench-ui-"));
  writeFileSync(path.join(dir, "example.txt"), "original text\n");
  let id = "",
    csrf = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `workbench fixture ${Date.now()}`;
  try {
    await page.addInitScript(() => {
      (window as any).__download = [];
      (window as any).showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (chunk: Uint8Array) =>
            (window as any).__download.push(...chunk),
          close: async () => {},
          abort: async () => {},
        }),
      });
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
      async ({ name, dir, nodeName }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("fixture node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`create ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
      },
      { name, dir, nodeName },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    expect(fixture.terminal.state).toBe("running");
    const pid = execFileSync(
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
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await page
      .locator(".terminal-mount")
      .evaluate((e) => e.setAttribute("data-fixture-stable", "yes"));
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page.getByRole("button", { name: "example.txt", exact: true }),
    ).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传文件到所选目录" }).click();
    await (
      await chooserPromise
    ).setFiles({
      name: "uploaded.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("upload from browser\n"),
    });
    await expect
      .poll(() => {
        try {
          return readFileSync(path.join(dir, "uploaded.txt"), "utf8");
        } catch {
          return "";
        }
      })
      .toBe("upload from browser\n");
    await expect(
      page.getByRole("button", { name: "uploaded.txt", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下载 uploaded.txt" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          new TextDecoder().decode(new Uint8Array((window as any).__download)),
        ),
      )
      .toBe("upload from browser\n");
    writeFileSync(path.join(dir, "added-after-open.txt"), "new\n");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page.getByRole("button", { name: "added-after-open.txt", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    await expect(page.locator(".monaco-editor")).toBeVisible();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("saved from workspace\n");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "example.txt"), "utf8"))
      .toBe("saved from workspace\n");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("unsaved while switching\n");
    await page.getByRole("button", { name: "终端模式" }).click();
    await expect(
      page.locator('.terminal-mount[data-fixture-stable="yes"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .last()
      .click();
    await expect(page.locator(".monaco-editor")).toContainText(
      "unsaved while switching",
    );
    const grip = page.getByRole("separator", { name: "调整文件树宽度" });
    const before = await grip.boundingBox();
    if (!before) throw new Error("missing sidebar handle");
    await page.mouse.move(before.x + 3, before.y + 120);
    await page.mouse.down();
    await page.mouse.move(before.x + 83, before.y + 120, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await grip.boundingBox())?.x)
      .toBeGreaterThan(before.x + 60);
    const heightGrip = page.getByRole("separator", {
      name: "调整编辑器和终端高度",
    });
    const vertical = await heightGrip.boundingBox();
    if (!vertical) throw new Error("missing height handle");
    await page.mouse.move(vertical.x + 100, vertical.y + 3);
    await page.mouse.down();
    await page.mouse.move(vertical.x + 100, vertical.y - 70, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await heightGrip.boundingBox())?.y)
      .toBeLessThan(vertical.y - 40);
    await expect
      .poll(() =>
        page
          .locator(".terminal-workspace:not(.hidden) .terminal-screen")
          .evaluate((element) => {
            const clip = element.getBoundingClientRect();
            const grid = element
              .querySelector(".xterm-screen")!
              .getBoundingClientRect();
            const last = element
              .querySelector(".xterm-rows")!
              .lastElementChild!.getBoundingClientRect();
            const footer = document
              .querySelector(
                ".terminal-workspace:not(.hidden) .terminal-statusbar",
              )!
              .getBoundingClientRect();
            return (
              grid.right <= clip.right + 0.5 && last.bottom <= footer.top + 0.5
            );
          }),
      )
      .toBe(true);
    await page.screenshot({ path: "../test-results/workbench-mode.png" });
    await page.waitForTimeout(800); // let the draft transaction complete
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "example.txt", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    await expect(page.locator(".monaco-editor")).toContainText(
      "unsaved while switching",
    );
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      (window as any).workbenchOriginalSend = original;
      WebSocket.prototype.send = function (data) {
        let delayed = false;
        if (typeof data === "string") {
          try {
            delayed = JSON.parse(data).type === "file.write.commit";
          } catch {}
        }
        if (delayed) {
          setTimeout(() => original.call(this, data), 1000);
          return;
        }
        original.call(this, data);
      };
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存中…" })).toBeVisible();
    const reopenedEditor = page.locator(".monaco-editor textarea.inputarea");
    await reopenedEditor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("new edits during save\n");
    await expect
      .poll(() => readFileSync(path.join(dir, "example.txt"), "utf8"))
      .toBe("unsaved while switching\n");
    await expect(page.locator(".monaco-editor")).toContainText(
      "new edits during save",
    );
    await expect(page.locator("[aria-label='未保存']")).toBeVisible();
    await page.evaluate(() => {
      WebSocket.prototype.send = (window as any).workbenchOriginalSend;
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "example.txt"), "utf8"))
      .toBe("new edits during save\n");
    expect(errors).toEqual([]);
    expect(
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
      ).trim(),
    ).toBe(pid);
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
