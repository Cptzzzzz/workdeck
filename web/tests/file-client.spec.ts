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
