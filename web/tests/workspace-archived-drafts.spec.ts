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
  "requires an isolated local node",
);

test("old workspace revisions export both page and stored drafts after another device changes the root", async ({
  page,
  browser,
}) => {
  const dir = mkdtempSync(path.join(root!, "archive-ui-"));
  const first = path.join(dir, "first"),
    second = path.join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(path.join(first, "same.txt"), "old file\n");
  writeFileSync(path.join(second, "same.txt"), "new root file\n");
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-archive-"));
  const bundle = path.join(bundleDir, "client.js");
  const name = `archive fixture ${Date.now()}`;
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
    const password = readFileSync(
      process.env.WORKDECK_TEST_PASSWORD_FILE!,
      "utf8",
    ).trim();
    const login = async (p: typeof page) => {
      await p.goto(url + "/?transport=relay");
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
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("isolated node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: first }),
        });
        if (!response.ok) throw new Error(`terminal ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
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
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page.getByRole("button", { name: "same.txt", exact: true }).click();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("unsaved page content\n");
    await page.route("**/__archive-harness.js", (r) =>
      r.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__archive-harness.js" });
    const old = await page.evaluate(
      async ({ id, nodeID }) => {
        const view = await fetch(`/api/terminals/${id}/workspace`).then((r) =>
          r.json(),
        );
        const identity = {
          account: "admin",
          nodeID,
          workspaceID: view.workspace.id,
          rootRevision: view.workspace.root_revision,
          path: "same.txt",
        };
        const drafts = (window as any).workdeckFileTest.drafts;
        let saved: any;
        for (let i = 0; i < 30; i++) {
          saved = await drafts.loadDraft(identity);
          if (saved?.text === "unsaved page content\n") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (saved?.text !== "unsaved page content\n")
          throw new Error("page draft not persisted");
        const content = Uint8Array.from({ length: 100001 }, (_, i) => i % 251);
        const pendingSave = {
          opID: "fixture-operation",
          spec: {
            path: "same.txt",
            size: content.length,
            sha256: "fixture-digest",
            create: false,
          },
          content,
        };
        await drafts.saveDraft(
          {
            ...saved,
            text: "different stored content\n",
            sequence: saved.sequence + 1,
            pendingSave,
          },
          saved.token,
        );
        return identity;
      },
      { id, nodeID: fixture.terminal.node_id },
    );
    const secondDevice = await other.newPage();
    await login(secondDevice);
    const result = await secondDevice.evaluate(
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
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            `root change ${response.status}: ${JSON.stringify(result)}`,
          );
        return result;
      },
      { id, second, revision: old.rootRevision },
    );
    expect(result.workspace.root_revision).toBe(old.rootRevision + 1);
    const archive = page.locator(".archived-drafts");
    await expect(archive).toContainText("修订 1 · same.txt", {
      timeout: 20000,
    });
    const pageDownload = page.waitForEvent("download");
    await archive.getByRole("button", { name: "导出页面文本" }).click();
    expect(readFileSync((await (await pageDownload).path())!, "utf8")).toBe(
      "unsaved page content\n",
    );
    await expect(
      archive.getByRole("button", { name: "导出已保存文本" }),
    ).toBeVisible({ timeout: 15000 });
    const storedDownload = page.waitForEvent("download");
    await archive.getByRole("button", { name: "导出已保存文本" }).click();
    expect(readFileSync((await (await storedDownload).path())!, "utf8")).toBe(
      "different stored content\n",
    );
    const recordDownload = page.waitForEvent("download");
    await archive.getByRole("button", { name: "导出已保存记录" }).click();
    const record = JSON.parse(
      readFileSync((await (await recordDownload).path())!, "utf8"),
    );
    expect(record.pendingSave.opID).toBe("fixture-operation");
    const recovered = Buffer.from(record.pendingSave.contentBase64, "base64");
    expect(recovered.length).toBe(100001);
    expect(recovered.every((byte, i) => byte === i % 251)).toBe(true);
    await page.locator('.file-tree-row[title="same.txt"]').click();
    await expect(page.locator(".monaco-editor")).toContainText("new root file");
    expect(readFileSync(path.join(first, "same.txt"), "utf8")).toBe(
      "old file\n",
    );
    expect(readFileSync(path.join(second, "same.txt"), "utf8")).toBe(
      "new root file\n",
    );
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".archived-drafts")).toContainText(
      "修订 1 · same.txt",
    );
    const afterReload = page.waitForEvent("download");
    await page
      .locator(".archived-drafts")
      .getByRole("button", { name: "导出已保存文本" })
      .click();
    expect(readFileSync((await (await afterReload).path())!, "utf8")).toBe(
      "different stored content\n",
    );
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
    await other.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
