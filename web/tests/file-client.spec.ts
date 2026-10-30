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
    await page.goto("/");
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
        client.close();
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

test("downloads stream in bounded chunks and reject oversized browser fallback", async ({
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
        openRead: async () => ({ id: "read", entry: { size } }),
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
      let rejected = false;
      try {
        await downloadFile(client, "large.bin");
      } catch (error) {
        rejected = (error as any).code === "FILE_TOO_LARGE";
      }
      return {
        total,
        largest,
        closed,
        rejected,
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
      rejected: true,
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
      const moves = await drafts.moveDrafts(scope, "project", "renamed");
      const moved = await drafts.loadDraft(make("renamed/a.txt").identity);
      let stale = false;
      try {
        await drafts.saveDraft(make("project/a.txt"), a.token);
      } catch (e) {
        stale = (e as Error).name === "DraftConflictError";
      }
      return {
        conflict,
        retained,
        pendingBlocked,
        count: moves.length,
        text: moved.text,
        oldRemoved: !(await drafts.loadDraft(make("project/a.txt").identity)),
        otherRetained: !!(await drafts.loadDraft(other.identity)),
        stale,
      };
    });
    expect(migration).toEqual({
      conflict: true,
      retained: true,
      pendingBlocked: true,
      count: 2,
      text: "project/a.txt",
      oldRemoved: true,
      otherRetained: true,
      stale: true,
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
                  payload: { result: { bytes: 5 } },
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
      return {
        old: old.text,
        duplicate,
        count: listed.length,
        remaining: (await drafts.listCreateIntents(scope)).length,
      };
    });
    expect(result).toEqual({
      old: "unsaved",
      duplicate: true,
      count: 1,
      remaining: 0,
    });
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
