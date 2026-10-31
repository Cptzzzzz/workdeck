import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  process.env.WORKDECK_ARCHIVE_ACCEPTANCE !== "1" ||
    !root ||
    !nodeName ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires a dedicated localhost node with archived-operation support",
);

test("old operation journals are inspected without replay and removed only after explicit confirmation", async ({
  page,
  browser,
}) => {
  const dir = mkdtempSync(path.join(root!, "archive-ops-ui-")),
    first = path.join(dir, "first"),
    second = path.join(dir, "second"),
    deleted = path.join(first, "delete-dir");
  mkdirSync(first);
  mkdirSync(second);
  mkdirSync(deleted);
  for (let i = 0; i < 70; i++)
    writeFileSync(
      path.join(deleted, `file-${String(i).padStart(2, "0")}.txt`),
      `old ${i}\n`,
    );
  writeFileSync(path.join(first, "rename-old.txt"), "old rename\n");
  writeFileSync(path.join(first, "save.txt"), "old before\n");
  writeFileSync(path.join(second, "save.txt"), "new root sentinel\n");
  const bundleDir = mkdtempSync(
      path.join(os.tmpdir(), "workdeck-archive-ops-"),
    ),
    bundle = path.join(bundleDir, "client.js"),
    name = `archive operations ${Date.now()}`;
  let id = "",
    csrf = "";
  const direct = process.env.WORKDECK_ARCHIVE_DIRECT === "1";
  const other = await browser.newContext();
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    const password = readFileSync(
      process.env.WORKDECK_TEST_PASSWORD_FILE!,
      "utf8",
    ).trim();
    const login = async (p: typeof page) => {
      await p.goto(
        url + (direct ? "/?file_transport=direct" : "/?transport=relay"),
      );
      await p.getByLabel("用户名").fill("admin");
      await p.getByLabel("密码", { exact: true }).fill(password);
      await p.getByRole("button", { name: "进入工作台" }).click();
      await expect(
        p.getByRole("heading", { name: "你的远程工作台." }),
      ).toBeVisible();
    };
    await login(page);
    const fixture = await page.evaluate(
      async ({ name, first, nodeName }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) =>
            n.name === nodeName &&
            n.online &&
            n.capabilities.includes("workspace-archive-v1"),
        );
        if (nodes.length !== 1)
          throw new Error("archive test node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: first }),
        });
        if (!response.ok) throw new Error(`terminal ${response.status}`);
        const terminal = await response.json();
        const init = await fetch(`/api/terminals/${terminal.id}/workspace`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: "{}",
        });
        if (!init.ok) throw new Error(`workspace ${init.status}`);
        return {
          terminal,
          workspace: (await init.json()).workspace,
          csrf: me.csrf,
        };
      },
      { name, first, nodeName },
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
    await page.route("**/__archive-ops-harness.js", (r) =>
      r.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__archive-ops-harness.js" });
    const operationIDs = await page.evaluate(
      async ({ workspace, csrf, nodeID, first }) => {
        const h = (window as any).workdeckFileTest;
        h.setCSRF(csrf);
        const client = await h.FileClient.connect(workspace),
          base = {
            account: "admin",
            nodeID,
            workspaceID: workspace.id,
            rootRevision: workspace.root_revision,
            rootPath: first,
            createdAt: Date.now(),
          };
        try {
          const directory = client.newOperationID();
          await h.drafts.recordCreateIntent({
            ...base,
            opID: directory,
            kind: "directory",
            path: "made",
          });
          await client.createDirectory(directory, "made");
          const rename = client.newOperationID(),
            renameVersion = (await client.stat("rename-old.txt")).version;
          await h.drafts.recordCreateIntent({
            ...base,
            opID: rename,
            kind: "rename",
            path: "rename-new.txt",
            source: "rename-old.txt",
            version: renameVersion,
          });
          await client.rename(
            rename,
            "rename-old.txt",
            "rename-new.txt",
            renameVersion,
          );
          const del = client.newOperationID(),
            deleteVersion = (await client.stat("delete-dir")).version;
          await h.drafts.recordCreateIntent({
            ...base,
            opID: del,
            kind: "delete",
            path: "delete-dir",
            recursive: true,
            version: deleteVersion,
            confirmed: true,
          });
          let state = await client.prepareDelete(
            del,
            "delete-dir",
            deleteVersion,
            true,
          );
          while (state.state === "prepared" || state.state === "deleting")
            state = await client.commitDelete(del);
          if (state.state !== "committed" || state.deleted !== 71)
            throw new Error("fixture delete incomplete");
          const file = new File([new Uint8Array(90000).fill(73)], "upload.bin"),
            tx = await client.prepareUpload("upload.bin", file);
          await h.drafts.recordCreateIntent({
            ...base,
            opID: tx.opID,
            kind: "upload",
            path: "upload.bin",
            size: tx.spec.size,
            sha256: tx.spec.sha256,
            sourceName: file.name,
          });
          await client.upload(tx, file);
          const unknown = client.newOperationID();
          await h.drafts.recordCreateIntent({
            ...base,
            opID: unknown,
            kind: "file",
            path: "unknown.txt",
          });
          const mismatch = client.newOperationID();
          await h.drafts.recordCreateIntent({
            ...base,
            opID: mismatch,
            kind: "directory",
            path: "wrong-local-path",
          });
          await client.createDirectory(mismatch, "actual-directory");
          const original = await client.readBytes("save.txt"),
            save = await client.prepareSave(
              "save.txt",
              new TextEncoder().encode("old saved snapshot\n"),
              original.entry.version,
              false,
            );
          await client.save(save);
          await h.drafts.saveDraft(
            {
              identity: {
                account: "admin",
                nodeID,
                workspaceID: workspace.id,
                rootRevision: workspace.root_revision,
                path: "save.txt",
              },
              baseVersion: original.entry.version,
              baseText: "old before\n",
              text: "newer local draft\n",
              sequence: 1,
              encoding: "utf8",
              newline: "lf",
              pendingSave: save,
            },
            null,
          );
          return {
            directory,
            rename,
            del,
            upload: tx.opID,
            unknown,
            mismatch,
            save: save.opID,
          };
        } finally {
          client.close();
        }
      },
      {
        workspace: fixture.workspace,
        csrf,
        nodeID: fixture.terminal.node_id,
        first,
      },
    );
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page
        .locator(".workbench-intents")
        .filter({ hasText: "待确认的文件操作" }),
    ).toContainText("delete-dir");
    const secondDevice = await other.newPage();
    await login(secondDevice);
    await secondDevice.evaluate(
      async ({ id, second, revision }) => {
        const me = await fetch("/api/me").then((r) => r.json());
        const response = await fetch(`/api/terminals/${id}/workspace`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ root_path: second, root_revision: revision }),
        });
        if (!response.ok) throw new Error(`root change ${response.status}`);
      },
      { id, second, revision: fixture.workspace.root_revision },
    );
    const archives = page
      .locator(".workbench-intents")
      .filter({ hasText: "旧目录的待确认操作" });
    await expect(archives).toContainText("delete-dir", { timeout: 20000 });
    if (direct)
      await expect(page.locator(".workbench-route")).toContainText(
        "WebRTC 直连",
        { timeout: 30000 },
      );
    const open = async (pathPart: string) => {
      await archives
        .locator(":scope > div")
        .filter({ hasText: pathPart })
        .getByRole("button", { name: "核对或导出记录" })
        .click();
      return page.getByRole("dialog", { name: "核对旧目录操作" });
    };
    let dialog = await open("made");
    await expect(dialog).toContainText(first);
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("status")).toContainText("已完成");
    const recordPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出本地记录" }).click();
    const record = JSON.parse(
      readFileSync((await (await recordPromise).path())!, "utf8"),
    );
    expect(record.intent.opID).toBe(operationIDs.directory);
    expect(record.nodeSnapshot.state).toBe("committed");
    await expect(
      dialog.getByRole("button", { name: "确认移除本地记录" }),
    ).toBeDisabled();
    await dialog.getByLabel("我已核对原目录", { exact: false }).check();
    await dialog.getByRole("button", { name: "确认移除本地记录" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      archives.locator(":scope > div").filter({ hasText: "made" }),
    ).toHaveCount(0);
    dialog = await open("rename-new.txt");
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("status")).toContainText("已完成");
    await expect(dialog).toContainText("rename-old.txt");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    dialog = await open("upload.bin");
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("status")).toContainText("已完成");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    dialog = await open("delete-dir");
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("status")).toContainText("已删除 71 项");
    await dialog.getByRole("button", { name: "查看删除明细" }).click();
    await expect
      .poll(() => dialog.locator(".archived-outcomes li").count())
      .toBeGreaterThan(0);
    const firstPageCount = await dialog
      .locator(".archived-outcomes li")
      .count();
    expect(firstPageCount).toBeLessThan(71);
    for (
      let i = 0;
      i < 5 &&
      (await dialog
        .getByRole("button", { name: "继续查看删除明细" })
        .isVisible());
      i++
    ) {
      const before = await dialog.locator(".archived-outcomes li").count();
      await dialog.getByRole("button", { name: "继续查看删除明细" }).click();
      await expect
        .poll(() => dialog.locator(".archived-outcomes li").count())
        .toBeGreaterThan(before);
    }
    await expect(dialog.locator(".archived-outcomes li")).toHaveCount(71);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    dialog = await open("unknown.txt");
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "不能证明操作没有执行",
    );
    await expect(
      dialog.getByRole("button", { name: "确认移除本地记录" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    dialog = await open("wrong-local-path");
    await dialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(dialog.getByRole("alert")).toContainText("不匹配");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const oldDraft = page
      .locator(".archived-drafts")
      .filter({ hasText: "旧目录的本地草稿" });
    await oldDraft.getByRole("button", { name: "核对已保存记录" }).click();
    const saveDialog = page.getByRole("dialog", { name: "核对旧目录保存" });
    await saveDialog.getByRole("button", { name: "核对节点记录" }).click();
    await expect(saveDialog.getByRole("status")).toContainText("已完成");
    await saveDialog.getByRole("button", { name: "关闭", exact: true }).click();
    if (direct)
      await expect(page.locator(".workbench-route")).toContainText(
        "WebRTC 直连",
      );
    expect(readFileSync(path.join(second, "save.txt"), "utf8")).toBe(
      "new root sentinel\n",
    );
    expect(existsSync(path.join(first, "delete-dir"))).toBe(false);
    expect(readFileSync(path.join(first, "rename-new.txt"), "utf8")).toBe(
      "old rename\n",
    );
    expect(pane()).toBe(pid);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    const after = page
      .locator(".workbench-intents")
      .filter({ hasText: "旧目录的待确认操作" });
    await expect(after).toContainText("unknown.txt");
    await expect(after).not.toContainText("made");
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
