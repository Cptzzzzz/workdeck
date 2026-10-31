import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const testRoot = process.env.WORKDECK_FILE_TEST_ROOT;
const testNode = process.env.WORKDECK_TEST_NODE_NAME;
const testURL = process.env.WORKDECK_TEST_URL || "";
// These tests create and close a real fixture session, so they never run
// against the default server or without an explicitly configured test node.
test.skip(
  !testRoot || !testNode || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testURL),
  "requires an explicitly configured isolated localhost fixture",
);

test("browser file client reads, saves, resumes, and leaves the terminal running", async ({
  page,
}) => {
  const root = mkdtempSync(path.join(testRoot!, "file-client-"));
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-file-test-"));
  const bundle = path.join(bundleDir, "client.js");
  let terminalID = "",
    csrf = "";
  try {
    writeFileSync(path.join(root, "source.txt"), "浏览器文件测试\r\n");
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/?transport=relay");
    const password = readFileSync(
      process.env.WORKDECK_TEST_PASSWORD_FILE!,
      "utf8",
    ).trim();
    await page.getByLabel("用户名").fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    const fixture = await page.evaluate(
      async ({ nodeName, rootPath }) => {
        const me = await fetch("/api/me").then((r) => r.json());
        const state = await fetch("/api/state").then((r) => r.json());
        const matches = state.nodes.filter(
          (n: { name: string; online: boolean }) =>
            n.name === nodeName && n.online,
        );
        if (matches.length !== 1) throw new Error("isolated node unavailable");
        const res = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({
            node_id: matches[0].id,
            name: "file-client fixture",
            cwd: rootPath,
          }),
        });
        if (!res.ok) throw new Error(`fixture terminal: ${res.status}`);
        return { terminal: await res.json(), csrf: me.csrf };
      },
      { nodeName: testNode, rootPath: root },
    );
    terminalID = fixture.terminal.id;
    csrf = fixture.csrf;
    expect(fixture.terminal.state).toBe("running");
    const pid = execFileSync(
      "tmux",
      [
        "-L",
        `workdeck-${terminalID}`,
        "display-message",
        "-p",
        "-t",
        "main",
        "#{pane_pid}",
      ],
      { encoding: "utf8" },
    ).trim();
    const workspace = await page.evaluate(
      async ({ id, csrf }) => {
        const res = await fetch(`/api/terminals/${id}/workspace`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": csrf,
          },
          body: "{}",
        });
        if (!res.ok) throw new Error(`workspace: ${res.status}`);
        return (await res.json()).workspace;
      },
      { id: terminalID, csrf },
    );
    await page.route("**/__file-client-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__file-client-harness.js" });
    const outcome = await page.evaluate(
      async ({ workspace, csrf }) => {
        const harness = (window as any).workdeckFileTest;
        harness.setCSRF(csrf);
        let client = await harness.FileClient.connect(workspace);
        const list = await client.list(".", true);
        if (!list.entries.some((e: any) => e.name === "source.txt"))
          throw new Error("listing missing file");
        const original = await client.readBytes("source.txt");
        if (new TextDecoder().decode(original.bytes) !== "浏览器文件测试\r\n")
          throw new Error("wrong content");
        const bytes = new TextEncoder().encode("chunked-" + "界".repeat(22000));
        const tx = await client.prepareSave("saved.txt", bytes, "", true);
        const originalSend = WebSocket.prototype.send;
        let interrupted = false;
        WebSocket.prototype.send = function (data: any) {
          if (
            typeof data === "string" &&
            JSON.parse(data).type === "file.write.commit" &&
            !interrupted
          ) {
            interrupted = true;
            this.close();
            return;
          }
          return originalSend.call(this, data);
        };
        let uncertain = false;
        try {
          await client.save(tx);
        } catch (error) {
          uncertain =
            error instanceof harness.UncertainSaveError &&
            error.transaction.opID === tx.opID;
        } finally {
          WebSocket.prototype.send = originalSend;
        }
        if (!uncertain)
          throw new Error("lost commit confirmation not marked uncertain");
        client = await harness.FileClient.connect(workspace);
        const status = await client.operationStatus(tx.opID);
        if (status.state !== "ready") throw new Error("upload state lost");
        const saved = await client.save(tx);
        if (saved.state !== "committed") throw new Error("save not committed");
        const loaded = await client.readBytes("saved.txt", saved.version);
        if (
          loaded.bytes.length !== bytes.length ||
          loaded.bytes.some((b: number, i: number) => b !== bytes[i])
        )
          throw new Error("roundtrip mismatch");
        const renameData = new TextEncoder().encode("rename me");
        const renameCreate = await client.prepareSave(
          "rename-source.txt",
          renameData,
          "",
          true,
        );
        await client.save(renameCreate);
        const renameVersion = (await client.stat("rename-source.txt")).version;
        const renameID = client.newOperationID();
        const renamed = await client.rename(
          renameID,
          "rename-source.txt",
          "renamed.txt",
          renameVersion,
        );
        if (
          renamed.state !== "committed" ||
          (await client.operationStatus(renameID, "entry.rename")).state !==
            "committed"
        )
          throw new Error("rename confirmation lost");
        if (
          new TextDecoder().decode(
            (await client.readBytes("renamed.txt")).bytes,
          ) !== "rename me"
        )
          throw new Error("renamed content mismatch");
        const deleteID = client.newOperationID();
        const deleteVersion = (await client.stat("renamed.txt")).version;
        const deletion = await client.prepareDelete(
          deleteID,
          "renamed.txt",
          deleteVersion,
          false,
        );
        if (
          deletion.state !== "prepared" ||
          deletion.count !== 1 ||
          (await client.stat("renamed.txt")).kind !== "file"
        )
          throw new Error("delete preview changed file");
        const deleted = await client.commitDelete(deleteID);
        const outcome = await client.deleteOutcomes(deleteID, 0);
        if (
          deleted.state !== "committed" ||
          deleted.deleted !== 1 ||
          outcome.items.length !== 1 ||
          outcome.items[0].state !== "deleted" ||
          (await client.deleteStatus(deleteID)).state !== "committed"
        )
          throw new Error("delete result mismatch");
        const fileBytes = new Uint8Array(1024 * 1024 + 123);
        for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = i % 251;
        const file = new File([fileBytes], "upload.bin");
        const upload = await client.prepareUpload("upload.bin", file);
        let chunks = 0;
        WebSocket.prototype.send = function (data: any) {
          if (data instanceof ArrayBuffer && ++chunks === 3) {
            this.close();
            return;
          }
          return originalSend.call(this, data);
        };
        let disconnected = false;
        try {
          await client.upload(upload, file);
        } catch {
          disconnected = true;
        } finally {
          WebSocket.prototype.send = originalSend;
        }
        if (!disconnected) throw new Error("upload did not disconnect");
        client = await harness.FileClient.connect(workspace);
        const uploadStatus = await client.operationStatus(upload.opID);
        if (uploadStatus.offset <= 0 || uploadStatus.offset >= file.size)
          throw new Error("upload offset was not persisted");
        let mismatch = false;
        try {
          await client.upload(
            upload,
            new File([new Uint8Array(file.size)], file.name),
          );
        } catch (error) {
          mismatch = (error as any).code === "SOURCE_MISMATCH";
        }
        if (!mismatch) throw new Error("different source was accepted");
        const uploaded = await client.upload(upload, file);
        const cancelled = await client.prepareUpload("cancelled.bin", file);
        const abort = new AbortController();
        let stopped = false;
        try {
          await client.upload(cancelled, file, {
            signal: abort.signal,
            onProgress: (done: number) => {
              if (done >= 65536) abort.abort();
            },
          });
        } catch (error) {
          stopped = (error as Error).name === "AbortError";
        }
        if (!stopped) throw new Error("upload did not stop after cancellation");
        const beforeAbort = await client.operationStatus(cancelled.opID);
        if (beforeAbort.state !== "receiving" || beforeAbort.offset !== 65536)
          throw new Error("unexpected cancelled offset");
        const aborted = await client.abortUpload(cancelled);
        if (
          aborted.state !== "aborted" ||
          (await client.operationStatus(cancelled.opID)).state !== "aborted"
        )
          throw new Error("cancel was not durable");
        const roundtrip = await client.readBytes(
          "upload.bin",
          uploaded.version,
          file.size,
        );
        if (
          roundtrip.bytes.length !== fileBytes.length ||
          roundtrip.bytes.some((b: number, i: number) => b !== fileBytes[i])
        )
          throw new Error("resumed upload mismatch");
        const stale = await client.prepareSave(
          "source.txt",
          new TextEncoder().encode("changed"),
          "wrong-version",
          false,
        );
        let conflict = false;
        try {
          await client.save(stale);
        } catch (error) {
          conflict =
            (error as any).code === "VERSION_CONFLICT" ||
            (error as any).code === "CONFLICT";
        }
        const pressure = harness.terminalPressure.registerTerminalPressure(
          workspace.terminal_id,
        );
        const now = performance.now();
        const samples = [20, 20, 20, 500, 500, 500, 500, 500, 500, 500, 500];
        samples.forEach((latency, i) =>
          pressure.sample(
            "relay",
            latency,
            now - (samples.length - i - 1) * 5000,
          ),
        );
        if (
          harness.terminalPressure.terminalPressureDelay(
            workspace.terminal_id,
          ) !== 250
        )
          throw new Error("adaptive pacing did not engage");
        const opened = await client.openRead("source.txt");
        let chunkDone = false;
        const delayed = client.readChunk(opened.id, 0, 1).then((v: any) => {
          chunkDone = true;
          return v;
        });
        await client.stat("source.txt");
        if (chunkDone)
          throw new Error("control request waited behind paced data");
        if ((await delayed).length !== 1)
          throw new Error("paced read lost data");
        const abortDelay = new AbortController();
        const canceled = client.readChunk(opened.id, 0, 1, abortDelay.signal);
        abortDelay.abort();
        try {
          await canceled;
          throw new Error("paced read ignored cancellation");
        } catch (error) {
          if ((error as Error).name !== "AbortError") throw error;
        }
        await client.closeRead(opened.id);
        const nextRead = await client.openRead("source.txt");
        const disconnectedWhilePaced = client.readChunk(nextRead.id, 0, 1);
        client.close();
        try {
          await disconnectedWhilePaced;
          throw new Error("paced read survived connection close");
        } catch (error) {
          if ((error as any).code !== "CONNECTION_LOST") throw error;
        }
        pressure.close();
        return { uncertain, conflict, size: loaded.bytes.length };
      },
      { workspace, csrf },
    );
    expect(outcome.uncertain).toBe(true);
    expect(outcome.conflict).toBe(true);
    expect(outcome.size).toBeGreaterThan(32768);
    expect(
      execFileSync(
        "tmux",
        [
          "-L",
          `workdeck-${terminalID}`,
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
    if (terminalID)
      await page.evaluate(
        async ({ id, csrf }) => {
          await fetch(`/api/terminals/${id}`, {
            method: "DELETE",
            headers: { "X-Workdeck-CSRF": csrf },
          });
        },
        { id: terminalID, csrf },
      );
    rmSync(root, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("downloads stream in bounded chunks and use a bounded browser fallback", async ({
  page,
}) => {
  const bundleDir = mkdtempSync(
    path.join(os.tmpdir(), "workdeck-download-test-"),
  );
  const bundle = path.join(bundleDir, "client.js");
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/");
    await page.route("**/__download-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__download-harness.js" });
    const result = await page.evaluate(async () => {
      const { downloadFile } = (window as any).workdeckFileTest;
      let size = 1024 * 1024 + 7,
        total = 0,
        largest = 0,
        closed = 0,
        reads = 0;
      const client = {
        workspace: { id: "b".repeat(48) },
        openRead: async () => ({
          id: "read",
          entry: { size, version: "a".repeat(64) },
        }),
        readChunk: async (_id: string, _offset: number, length: number) => {
          reads++;
          return new Uint8Array(length);
        },
        closeRead: async () => {
          closed++;
        },
      };
      (window as any).showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (chunk: Uint8Array) => {
            total += chunk.length;
            largest = Math.max(largest, chunk.length);
          },
          close: async () => {},
          abort: async () => {},
        }),
      });
      await downloadFile(client, "large.bin");
      const controller = new AbortController();
      let cancelledWrite = false,
        closedWrite = false,
        cancelled = false;
      (window as any).showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async () => controller.abort(),
          close: async () => {
            closedWrite = true;
          },
          abort: async () => {
            cancelledWrite = true;
          },
        }),
      });
      try {
        await downloadFile(client, "large.bin", controller.signal);
      } catch (error) {
        cancelled = (error as Error).name === "AbortError";
      }
      delete (window as any).showSaveFilePicker;
      size = 21 * 1024 * 1024;
      const before = reads;
      const oldFetch = window.fetch,
        oldClick = HTMLAnchorElement.prototype.click;
      let launched = "",
        requested = "",
        browserNotice = false;
      window.fetch = async (_url, init) => {
        requested = String(init?.body);
        return new Response(JSON.stringify({ ticket: "c".repeat(48) }), {
          status: 200,
        });
      };
      HTMLAnchorElement.prototype.click = function () {
        launched = this.getAttribute("href") || "";
      };
      try {
        await downloadFile(client, "large.bin", undefined, undefined, () => {
          browserNotice = true;
        });
      } finally {
        window.fetch = oldFetch;
        HTMLAnchorElement.prototype.click = oldClick;
      }
      return {
        total,
        largest,
        closed,
        fallback:
          launched.endsWith("/downloads/" + "c".repeat(48)) &&
          JSON.parse(requested).size === size &&
          browserNotice,
        fallbackReads: reads - before,
        cancelled,
        cancelledWrite,
        closedWrite,
      };
    });
    expect(result).toEqual({
      total: 1024 * 1024 + 7,
      largest: 32768,
      closed: 3,
      fallback: true,
      fallbackReads: 0,
      cancelled: true,
      cancelledWrite: true,
      closedWrite: false,
    });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("draft storage prevents stale writes and preserves a pending save", async ({
  page,
}) => {
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-draft-test-"));
  const bundle = path.join(bundleDir, "client.js");
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/");
    await page.route("**/__file-client-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__file-client-harness.js" });
    const result = await page.evaluate(async () => {
      const drafts = (window as any).workdeckFileTest.drafts;
      const identity = {
        account: "fixture",
        nodeID: crypto.randomUUID(),
        workspaceID: "fixture",
        rootRevision: 1,
        path: "src/example.txt",
      };
      const draft = {
        identity,
        baseVersion: "v1",
        baseText: "before",
        text: "local",
        sequence: 1,
        encoding: "utf8",
        newline: "lf",
        pendingSave: {
          opID: "operation",
          spec: { path: identity.path, size: 2, sha256: "digest" },
          content: new Uint8Array([1, 2]),
        },
      };
      const first = await drafts.saveDraft(draft, null);
      const loaded = await drafts.loadDraft(identity);
      if (loaded.text !== "local" || loaded.pendingSave.content[1] !== 2)
        throw new Error("draft not restored");
      const attempts = await Promise.allSettled([
        drafts.saveDraft({ ...draft, text: "tab a", sequence: 2 }, first.token),
        drafts.saveDraft({ ...draft, text: "tab b", sequence: 2 }, first.token),
      ]);
      if (
        attempts.filter((a) => a.status === "fulfilled").length !== 1 ||
        attempts.filter(
          (a) =>
            a.status === "rejected" && a.reason.name === "DraftConflictError",
        ).length !== 1
      )
        throw new Error("stale write accepted");
      let staleDelete = false;
      try {
        await drafts.deleteDraft(identity, first.token);
      } catch (error) {
        staleDelete = (error as Error).name === "DraftConflictError";
      }
      const latest = await drafts.loadDraft(identity);
      await drafts.deleteDraft(identity, latest.token);
      return { staleDelete, deleted: !(await drafts.loadDraft(identity)) };
    });
    expect(result).toEqual({ staleDelete: true, deleted: true });
    const viewState = await page.evaluate(async () => {
      const views = (window as any).workdeckFileTest.viewState;
      const id = {
        account: "a",
        nodeID: crypto.randomUUID(),
        workspaceID: "workspace",
        rootRevision: 1,
        path: "document.pdf",
      };
      const other = { ...id, rootRevision: 2 };
      await Promise.all([
        views.writePDFView(id, {
          page: 2,
          zoom: 1.25,
          scrollTop: 20,
          scrollLeft: 0,
        }),
        views.writePDFView(id, {
          page: 3,
          zoom: 1.5,
          scrollTop: 40,
          scrollLeft: 5,
        }),
        views.writePDFView(other, {
          page: 1,
          zoom: 1,
          scrollTop: 0,
          scrollLeft: 0,
        }),
      ]);
      let rejected = false;
      try {
        await views.writePDFView(id, {
          page: 0,
          zoom: 1,
          scrollTop: 0,
          scrollLeft: 0,
        });
      } catch {
        rejected = true;
      }
      await Promise.all([
        views.writeEditorView(id, {
          line: 2,
          column: 3,
          scrollTop: 4,
          scrollLeft: 5,
        }),
        views.writeEditorView(id, {
          line: 8,
          column: 9,
          scrollTop: 10,
          scrollLeft: 11,
        }),
      ]);
      let editorRejected = false;
      try {
        await views.writeEditorView(id, {
          line: 0,
          column: 1,
          scrollTop: 0,
          scrollLeft: 0,
        });
      } catch {
        editorRejected = true;
      }
      const scope = {
        account: id.account,
        nodeID: id.nodeID,
        workspaceID: id.workspaceID,
        rootRevision: id.rootRevision,
      };
      await Promise.all([
        views.writeWorkspaceTabs(scope, {
          paths: ["first.txt"],
          selected: "first.txt",
        }),
        views.writeWorkspaceTabs(scope, {
          paths: ["first.txt", "dir/second.pdf"],
          selected: "dir/second.pdf",
        }),
      ]);
      let tabsRejected = false;
      try {
        await views.writeWorkspaceTabs(scope, {
          paths: ["../outside"],
          selected: null,
        });
      } catch {
        tabsRejected = true;
      }
      const editor = await views.readEditorView(id),
        tabs = await views.readWorkspaceTabs(scope);
      sessionStorage.clear();
      return {
        a: await views.readPDFView(id),
        b: await views.readPDFView(other),
        rejected,
        editor,
        editorFromDatabase: await views.readEditorView(id),
        editorOther: await views.readEditorView(other),
        editorRejected,
        tabs,
        tabsFromDatabase: await views.readWorkspaceTabs(scope),
        tabsOther: await views.readWorkspaceTabs({ ...scope, rootRevision: 2 }),
        tabsRejected,
      };
    });
    expect(viewState).toEqual({
      a: { page: 3, zoom: 1.5, scrollTop: 40, scrollLeft: 5 },
      b: { page: 1, zoom: 1, scrollTop: 0, scrollLeft: 0 },
      rejected: true,
      editor: { line: 8, column: 9, scrollTop: 10, scrollLeft: 11 },
      editorFromDatabase: { line: 8, column: 9, scrollTop: 10, scrollLeft: 11 },
      editorOther: undefined,
      editorRejected: true,
      tabs: {
        paths: ["first.txt", "dir/second.pdf"],
        selected: "dir/second.pdf",
      },
      tabsFromDatabase: {
        paths: ["first.txt", "dir/second.pdf"],
        selected: "dir/second.pdf",
      },
      tabsOther: undefined,
      tabsRejected: true,
    });
    const migration = await page.evaluate(async () => {
      const drafts = (window as any).workdeckFileTest.drafts;
      const scope = {
        account: "fixture",
        nodeID: crypto.randomUUID(),
        workspaceID: "workspace",
        rootRevision: 1,
      };
      const make = (path: string, extra: object = {}) => ({
        identity: { ...scope, path },
        baseVersion: "v",
        baseText: "before",
        text: path,
        sequence: 1,
        encoding: "utf8",
        newline: "lf",
        ...extra,
      });
      const a = await drafts.saveDraft(make("project/a.txt"), null);
      await drafts.saveDraft(make("project/nested/b.txt"), null);
      const other = make("project/a.txt");
      other.identity.account = "other-account";
      await drafts.saveDraft(other, null);
      const collision = await drafts.saveDraft(
        make("renamed/nested/b.txt"),
        null,
      );
      let conflict = false;
      try {
        await drafts.moveDrafts(scope, "project", "renamed");
      } catch {
        conflict = true;
      }
      const retained =
        !!(await drafts.loadDraft(make("project/a.txt").identity)) &&
        !!(await drafts.loadDraft(make("project/nested/b.txt").identity));
      await drafts.deleteDraft(collision.identity, collision.token);
      const pending = await drafts.saveDraft(
        make("project/pending.txt", { pendingSave: { opID: "pending" } }),
        null,
      );
      let pendingBlocked = false;
      try {
        await drafts.moveDrafts(scope, "project", "renamed");
      } catch {
        pendingBlocked = true;
      }
      await drafts.deleteDraft(pending.identity, pending.token);
      const unavailable = await drafts.saveDraft(
        make("project/unavailable.txt", { unavailable: true }),
        null,
      );
      let unavailableMoveBlocked = false,
        unavailableDeleteBlocked = false;
      try {
        await drafts.moveDrafts(scope, "project", "renamed");
      } catch {
        unavailableMoveBlocked = true;
      }
      try {
        await drafts.checkDeleteDrafts(scope, "project");
      } catch {
        unavailableDeleteBlocked = true;
      }
      await drafts.deleteDraft(unavailable.identity, unavailable.token);
      const moves = await drafts.moveDrafts(scope, "project", "renamed");
      const moved = await drafts.loadDraft(make("renamed/a.txt").identity);
      let stale = false;
      try {
        await drafts.saveDraft(make("project/a.txt"), a.token);
      } catch (e) {
        stale = (e as Error).name === "DraftConflictError";
      }
      const pendingDelete = await drafts.saveDraft(
        make("renamed/pending.txt", { pendingSave: { opID: "waiting" } }),
        null,
      );
      let deletionBlocked = false;
      try {
        await drafts.checkDeleteDrafts(scope, "renamed");
      } catch {
        deletionBlocked = true;
      }
      await drafts.deleteDraft(pendingDelete.identity, pendingDelete.token);
      const marks = await drafts.markDeletedDrafts(scope, ["renamed/a.txt"]);
      let oldTabBlocked = false;
      try {
        await drafts.saveDraft({ ...moved, text: "stale change" }, moved.token);
      } catch (e) {
        oldTabBlocked = (e as Error).name === "DraftConflictError";
      }
      const listedDeleted = await drafts.listDeletedDrafts(scope);
      return {
        conflict,
        retained,
        pendingBlocked,
        unavailableMoveBlocked,
        unavailableDeleteBlocked,
        count: moves.length,
        text: moved.text,
        oldRemoved: !(await drafts.loadDraft(make("project/a.txt").identity)),
        otherRetained: !!(await drafts.loadDraft(other.identity)),
        stale,
        deletionBlocked,
        markCount: marks.length,
        oldTabBlocked,
        listedDeleted: listedDeleted.map((id: any) => id.path),
      };
    });
    expect(migration).toEqual({
      conflict: true,
      retained: true,
      pendingBlocked: true,
      unavailableMoveBlocked: true,
      unavailableDeleteBlocked: true,
      count: 2,
      text: "project/a.txt",
      oldRemoved: true,
      otherRetained: true,
      stale: true,
      deletionBlocked: true,
      markCount: 1,
      oldTabBlocked: true,
      listedDeleted: ["renamed/a.txt"],
    });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("malformed file acknowledgements reject the pending request", async ({
  page,
}) => {
  const bundleDir = mkdtempSync(
    path.join(os.tmpdir(), "workdeck-file-protocol-"),
  );
  const bundle = path.join(bundleDir, "client.js");
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/");
    await page.route("**/__file-client-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.route("**/api/workspaces/*/connections", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ticket: "1".repeat(48) }),
      }),
    );
    await page.addScriptTag({ url: "/__file-client-harness.js" });
    const code = await page.evaluate(async () => {
      const old = window.WebSocket,
        workspace = {
          id: "a".repeat(48),
          terminal_id: "b".repeat(48),
          root_path: "/fixture",
          root_revision: 1,
          run_user: "fixture",
        };
      class FakeSocket {
        static OPEN = 1;
        static CLOSING = 2;
        readyState = 1;
        binaryType = "";
        onmessage: any;
        onerror: any;
        onclose: any;
        constructor() {
          setTimeout(
            () =>
              this.onmessage({
                data: JSON.stringify({
                  version: 1,
                  type: "file.ready",
                  request_id: "c".repeat(48),
                  workspace_id: workspace.id,
                  root_revision: 1,
                  route_epoch: 1,
                  payload: {
                    result: { node_time_ms: Date.now(), route: "relay" },
                  },
                }),
              }),
            0,
          );
        }
        send(data: string) {
          const request = JSON.parse(data);
          setTimeout(
            () =>
              this.onmessage({
                data: JSON.stringify({
                  ...request,
                  type: "result",
                  payload: { result: { bytes: 6 } },
                }),
              }),
            0,
          );
        }
        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      }
      (window as any).WebSocket = FakeSocket;
      try {
        const client = await (
          window as any
        ).workdeckFileTest.FileClient.connect(workspace);
        try {
          await client.readChunk("d".repeat(48), 0, 5);
          return "unexpected success";
        } catch (error) {
          return (error as any).code;
        }
      } finally {
        window.WebSocket = old;
      }
    });
    expect(code).toBe("PROTOCOL_ERROR");
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("read waits when control confirmation arrives before the data channel", async ({
  page,
}) => {
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-file-order-")),
    bundle = path.join(bundleDir, "client.js");
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/");
    await page.route("**/__order-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.route("**/api/workspaces/*/connections", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ticket: "1".repeat(48) }),
      }),
    );
    await page.addScriptTag({ url: "/__order-harness.js" });
    const result = await page.evaluate(async () => {
      const previous = window.WebSocket,
        w = {
          id: "a".repeat(48),
          terminal_id: "b".repeat(48),
          root_path: "/fixture",
          root_revision: 1,
          run_user: "fixture",
        };
      let completedBeforeData = false,
        completed = false;
      class FakeSocket {
        static OPEN = 1;
        static CLOSING = 2;
        readyState = 1;
        binaryType = "";
        onmessage: any;
        onclose: any;
        constructor() {
          setTimeout(
            () =>
              this.onmessage({
                data: JSON.stringify({
                  version: 1,
                  type: "file.ready",
                  request_id: "c".repeat(48),
                  workspace_id: w.id,
                  root_revision: 1,
                  route_epoch: 1,
                  payload: {
                    result: { node_time_ms: Date.now(), route: "relay" },
                  },
                }),
              }),
            0,
          );
        }
        send(data: string) {
          const request = JSON.parse(data);
          const makeFrame = (epoch: number, content: number[]) => {
            const frame = new ArrayBuffer(53),
              bytes = new Uint8Array(frame),
              view = new DataView(frame);
            bytes.set([87, 68, 70, 49, 1, 2, 0, 0]);
            for (let i = 0; i < 24; i++)
              bytes[8 + i] = parseInt(
                request.request_id.slice(i * 2, i * 2 + 2),
                16,
              );
            view.setBigUint64(32, 0n);
            view.setUint32(40, 5);
            view.setUint32(44, epoch);
            bytes.set(content, 48);
            return frame;
          };
          setTimeout(
            () => this.onmessage({ data: makeFrame(1, [9, 9, 9, 9, 9]) }),
            0,
          );
          setTimeout(
            () =>
              this.onmessage({
                data: JSON.stringify({
                  ...request,
                  type: "result",
                  payload: { result: { bytes: 5 } },
                }),
              }),
            0,
          );
          setTimeout(() => {
            completedBeforeData = completed;
            this.onmessage({
              data: makeFrame(request.route_epoch, [1, 2, 3, 4, 5]),
            });
          }, 30);
        }
        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      }
      (window as any).WebSocket = FakeSocket;
      try {
        const client = await (
          window as any
        ).workdeckFileTest.FileClient.connect(w);
        client.epoch = 2;
        const bytes = await client
          .readChunk("d".repeat(48), 0, 5)
          .then((v: Uint8Array) => {
            completed = true;
            return v;
          });
        client.close();
        return { completedBeforeData, bytes: Array.from(bytes) };
      } finally {
        window.WebSocket = previous;
      }
    });
    expect(result).toEqual({
      completedBeforeData: false,
      bytes: [1, 2, 3, 4, 5],
    });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("pending create intents survive migration and prevent duplicate targets", async ({
  page,
}) => {
  const bundleDir = mkdtempSync(
      path.join(os.tmpdir(), "workdeck-intent-test-"),
    ),
    bundle = path.join(bundleDir, "client.js");
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/");
    await page.route("**/__file-client-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__file-client-harness.js" });
    const result = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("workdeck-workspace-drafts", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("drafts");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const identity = {
        account: "fixture",
        nodeID: "node",
        workspaceID: "workspace",
        rootRevision: 1,
        path: "old.txt",
      };
      const key = JSON.stringify([
        identity.account,
        identity.nodeID,
        identity.workspaceID,
        identity.rootRevision,
        identity.path,
      ]);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").put(
          {
            identity,
            baseVersion: "old",
            baseText: "base",
            text: "unsaved",
            sequence: 1,
            encoding: "utf8",
            newline: "lf",
            token: "old-token",
            updatedAt: 1,
          },
          key,
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const drafts = (window as any).workdeckFileTest.drafts,
        scope = {
          account: "fixture",
          nodeID: "node",
          workspaceID: "workspace",
          rootRevision: 1,
        };
      const old = await drafts.loadDraft(identity);
      const intent = {
        ...scope,
        opID: "first",
        kind: "directory",
        path: "same",
        createdAt: 1,
      };
      await drafts.recordCreateIntent(intent);
      let duplicate = false;
      try {
        await drafts.recordCreateIntent({
          ...intent,
          opID: "second",
          kind: "file",
        });
      } catch {
        duplicate = true;
      }
      const listed = await drafts.listCreateIntents(scope);
      await drafts.removeCreateIntent("first");
      await drafts.recordCreateIntent({
        ...intent,
        opID: "delete",
        kind: "delete",
        path: "target",
        version: "v",
        recursive: false,
        confirmed: false,
      });
      const confirmed = await drafts.confirmDeleteIntent("delete");
      const recovered = await drafts.listCreateIntents(scope);
      await drafts.removeCreateIntent("delete");
      return {
        old: old.text,
        duplicate,
        count: listed.length,
        remaining: (await drafts.listCreateIntents(scope)).length,
        confirmed: confirmed.confirmed,
        recovered: recovered[0].confirmed,
      };
    });
    expect(result).toEqual({
      old: "unsaved",
      duplicate: true,
      count: 1,
      remaining: 0,
      confirmed: true,
      recovered: true,
    });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
