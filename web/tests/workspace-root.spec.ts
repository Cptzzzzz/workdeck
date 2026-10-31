import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires a dedicated local test node",
);

test("root selection protects drafts and reconciles a lost acknowledgement without changing the shell", async ({
  page,
  browser,
}) => {
  const dir = mkdtempSync(path.join(root!, "root-ui-")),
    child = path.join(dir, "child"),
    otherRoot = path.join(dir, "other");
  mkdirSync(child);
  mkdirSync(otherRoot);
  writeFileSync(path.join(dir, "same.txt"), "old root\n");
  writeFileSync(path.join(child, "same.txt"), "new root\n");
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-root-ui-")),
    bundle = path.join(bundleDir, "client.js");
  const name = `root fixture ${Date.now()}`;
  let id = "",
    csrf = "";
  const other = await browser.newContext();
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
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
        if (nodes.length !== 1) throw new Error("isolated node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`terminal ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
      },
      { name, dir, nodeName },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    const pane = (format: string) =>
      execFileSync(
        "tmux",
        ["-L", `workdeck-${id}`, "display-message", "-p", "-t", "main", format],
        { encoding: "utf8" },
      ).trim();
    const pid = pane("#{pane_pid}");
    await expect.poll(() => pane("#{pane_current_path}")).toBe(dir);
    const shellDir = pane("#{pane_current_path}");
    let rootRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().endsWith(`/api/terminals/${id}/workspace`)
      )
        rootRequests++;
    });
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "same.txt", exact: true }).click();
    const input = page.locator(".monaco-editor textarea.inputarea");
    await input.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("local draft\n");
    const openPicker = async () => {
      await page.getByRole("button", { name: "更换工作区目录" }).click();
      const dialog = page.getByRole("dialog", { name: "更换工作区目录" });
      await expect(
        dialog.getByRole("option", { name: "child/" }),
      ).toBeAttached();
      await dialog.getByLabel("进入子目录").selectOption(child);
      await expect(dialog.getByLabel("工作区目录")).toHaveValue(child);
      return dialog;
    };
    let dialog = await openPicker();
    await dialog.getByRole("button", { name: "确认切换目录" }).click();
    await expect(dialog.getByRole("alert")).toContainText("未保存草稿");
    expect(rootRequests).toBe(0);
    expect(readFileSync(path.join(dir, "same.txt"), "utf8")).toBe("old root\n");
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "same.txt"), "utf8"))
      .toBe("local draft\n");
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await page.route("**/__root-harness.js", (r) =>
      r.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__root-harness.js" });
    const pending = await page.evaluate(
      async ({ id, nodeID }) => {
        const workspace = (
          await fetch(`/api/terminals/${id}/workspace`).then((r) => r.json())
        ).workspace;
        const intent = {
          account: "admin",
          nodeID,
          workspaceID: workspace.id,
          rootRevision: workspace.root_revision,
          opID: crypto.randomUUID(),
          kind: "file",
          path: "pending.txt",
          createdAt: Date.now(),
        };
        await (window as any).workdeckFileTest.drafts.recordCreateIntent(
          intent,
        );
        return intent;
      },
      { id, nodeID: fixture.terminal.node_id },
    );
    dialog = await openPicker();
    await dialog.getByRole("button", { name: "确认切换目录" }).click();
    await expect(dialog.getByRole("alert")).toContainText("待确认文件操作");
    expect(rootRequests).toBe(0);
    await page.evaluate(
      async (opID) =>
        (window as any).workdeckFileTest.drafts.removeCreateIntent(opID),
      pending.opID,
    );
    await page.route(`**/api/terminals/${id}/workspace`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.abort("failed");
    });
    await dialog.getByRole("button", { name: "确认切换目录" }).click();
    await expect(
      dialog.getByRole("button", { name: "正在切换…" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeHidden({ timeout: 20000 });
    await expect(page.locator(".workbench-root")).toContainText(child, {
      timeout: 20000,
    });
    expect(rootRequests).toBe(1);
    await page.locator('.file-tree-row[title="same.txt"]').click();
    await expect(page.locator(".monaco-editor")).toContainText("new root");
    expect(readFileSync(path.join(child, "same.txt"), "utf8")).toBe(
      "new root\n",
    );
    expect(pane("#{pane_pid}")).toBe(pid);
    expect(pane("#{pane_current_path}")).toBe(shellDir);
    await page.getByRole("button", { name: "更换工作区目录" }).click();
    dialog = page.getByRole("dialog", { name: "更换工作区目录" });
    await expect(dialog.getByRole("button", { name: "上一级" })).toBeEnabled();
    await dialog.getByRole("button", { name: "上一级" }).click();
    await expect(dialog.getByRole("option", { name: "other/" })).toBeAttached();
    await dialog.getByLabel("进入子目录").selectOption(otherRoot);
    const secondDevice = await other.newPage();
    await secondDevice.goto(url + "/?transport=relay");
    await secondDevice.getByLabel("用户名").fill("admin");
    await secondDevice
      .getByLabel("密码", { exact: true })
      .fill(
        readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE!, "utf8").trim(),
      );
    await secondDevice.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      secondDevice.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    await secondDevice.evaluate(
      async ({ id, otherRoot }) => {
        const me = await fetch("/api/me").then((r) => r.json());
        const current = await fetch(`/api/terminals/${id}/workspace`).then(
          (r) => r.json(),
        );
        const response = await fetch(`/api/terminals/${id}/workspace`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({
            root_path: otherRoot,
            root_revision: current.workspace.root_revision,
          }),
        });
        if (!response.ok)
          throw new Error(`second device root change ${response.status}`);
      },
      { id, otherRoot },
    );
    await expect(page.locator(".workbench-root")).toContainText(otherRoot, {
      timeout: 20000,
    });
    await dialog.getByRole("button", { name: "确认切换目录" }).click();
    await expect(dialog.getByRole("alert")).toContainText("工作区已改变");
    expect(rootRequests).toBe(1);
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.unroute(`**/api/terminals/${id}/workspace`);
    await page.route(`**/api/terminals/${id}/workspace`, async (route) => {
      if (route.request().method() === "PUT") return route.abort("failed");
      return route.continue();
    });
    await page.getByRole("button", { name: "更换工作区目录" }).click();
    dialog = page.getByRole("dialog", { name: "更换工作区目录" });
    await dialog.getByLabel("工作区目录").fill(path.join(dir, "missing"));
    await dialog.getByRole("button", { name: "确认切换目录" }).click();
    await expect(dialog.getByRole("alert")).toContainText("目录切换未确认");
    await expect(page.locator(".workbench-root")).toContainText(otherRoot, {
      timeout: 20000,
    });
    expect(rootRequests).toBe(2);
    await dialog.getByRole("button", { name: "取消" }).click();
    expect(pane("#{pane_pid}")).toBe(pid);
    expect(pane("#{pane_current_path}")).toBe(shellDir);
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
    await other.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
