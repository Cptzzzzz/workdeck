import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
test("file WebRTC carries data and interrupted upload resumes through relay", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "file-direct-")),
    bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-file-peer-")),
    bundle = path.join(bundleDir, "client.js");
  let id = "",
    csrf = "";
  try {
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    await page.goto("/?file_transport=direct");
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
      async ({ nodeName, dir }) => {
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
          body: JSON.stringify({
            node_id: nodes[0].id,
            name: "file direct fixture",
            cwd: dir,
          }),
        });
        if (!r.ok) throw new Error(`terminal ${r.status}`);
        return { terminal: await r.json(), csrf: me.csrf };
      },
      { nodeName, dir },
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
    const workspace = await page.evaluate(
      async ({ id, csrf }) => {
        const r = await fetch(`/api/terminals/${id}/workspace`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": csrf,
          },
          body: "{}",
        });
        if (!r.ok) throw new Error(`workspace ${r.status}`);
        return (await r.json()).workspace;
      },
      { id, csrf },
    );
    await page.route("**/__file-direct-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__file-direct-harness.js" });
    const result = await page.evaluate(
      async ({ workspace, csrf }) => {
        const h = (window as any).workdeckFileTest;
        h.setCSRF(csrf);
        const originalCreate = RTCPeerConnection.prototype.createDataChannel,
          originalSend = WebSocket.prototype.send;
        const channels: Record<string, RTCDataChannel> = {};
        let relayBinary = 0;
        RTCPeerConnection.prototype.createDataChannel = function (
          label: string,
          options?: RTCDataChannelInit,
        ) {
          const ch = originalCreate.call(this, label, options);
          channels[label] = ch;
          return ch;
        };
        WebSocket.prototype.send = function (data: any) {
          if (data instanceof ArrayBuffer) relayBinary++;
          return originalSend.call(this, data);
        };
        let client: any;
        try {
          client = await h.FileClient.connect(workspace);
          await new Promise<void>((resolve, reject) => {
            if (client.route === "direct") {
              resolve();
              return;
            }
            const timer = setTimeout(
              () => reject(new Error("file peer did not become direct")),
              30000,
            );
            client.onRoute((route: string) => {
              if (route === "direct") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          let metrics: any;
          client.onMetrics((m: any) => (metrics = m));
          const bytes = new Uint8Array(120000);
          for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
          const transaction = await client.prepareSave(
            "direct.bin",
            bytes,
            "",
            true,
          );
          const saved = await client.save(transaction);
          const read = await client.readBytes("direct.bin", saved.version);
          if (
            read.bytes.length !== bytes.length ||
            read.bytes.some((b: number, i: number) => b !== bytes[i])
          )
            throw new Error("direct data mismatch");
          await new Promise((resolve) => setTimeout(resolve, 1100));
          const directSent = metrics.traffic.direct.sent,
            directReceived = metrics.traffic.direct.received,
            relayedBeforeFailure = relayBinary;
          const source = new File(
            [new Uint8Array(200000).fill(37)],
            "resume.bin",
          );
          const upload = await client.prepareUpload("resume.bin", source);
          let interrupted = false;
          try {
            await client.upload(upload, source, {
              onProgress: (done: number) => {
                if (done >= 32768) channels["workdeck-file-data"].close();
              },
            });
          } catch {
            interrupted = true;
          }
          if (!interrupted) throw new Error("direct upload did not interrupt");
          client = await h.FileClient.connect(workspace);
          if (client.route !== "relay")
            throw new Error("fallback did not start with relay");
          const status = await client.operationStatus(upload.opID);
          if (status.offset < 32768 || status.offset >= source.size)
            throw new Error("invalid persisted offset");
          const committed = await client.upload(upload, source);
          const loaded = await client.readBytes(
            "resume.bin",
            committed.version,
            source.size,
          );
          if (
            loaded.bytes.length !== source.size ||
            loaded.bytes.some((b: number) => b !== 37)
          )
            throw new Error("resumed upload mismatch");
          return {
            directSent,
            directReceived,
            relayedBeforeFailure,
            interrupted,
            fallback: client.route,
          };
        } finally {
          client?.close();
          RTCPeerConnection.prototype.createDataChannel = originalCreate;
          WebSocket.prototype.send = originalSend;
        }
      },
      { workspace, csrf },
    );
    expect(result.directSent).toBeGreaterThan(120000);
    expect(result.directReceived).toBeGreaterThan(120000);
    expect(result.relayedBeforeFailure).toBe(0);
    expect(result.interrupted).toBe(true);
    expect(result.fallback).toBe("relay");
    const separate = await page.context().browser()!.newContext();
    try {
      const other = await separate.newPage();
      await other.goto(`${url}/?file_transport=direct`);
      await other.getByLabel("用户名").fill("admin");
      await other
        .getByLabel("密码", { exact: true })
        .fill(
          readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE!, "utf8").trim(),
        );
      await other.getByRole("button", { name: "进入工作台" }).click();
      await expect(
        other.getByRole("heading", { name: "你的远程工作台." }),
      ).toBeVisible();
      await other.route("**/__file-direct-harness.js", (route) =>
        route.fulfill({ path: bundle, contentType: "text/javascript" }),
      );
      await other.addScriptTag({ url: "/__file-direct-harness.js" });
      const revoked = await other.evaluate(async (workspace) => {
        const h = (window as any).workdeckFileTest,
          me = await fetch("/api/me").then((r) => r.json());
        h.setCSRF(me.csrf);
        const client = await h.FileClient.connect(workspace);
        try {
          await new Promise<void>((resolve, reject) => {
            if (client.route === "direct") {
              resolve();
              return;
            }
            const timer = setTimeout(
              () => reject(new Error("second peer did not connect")),
              30000,
            );
            client.onRoute((route: string) => {
              if (route === "direct") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          const disconnected = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 10000);
            client.onDisconnect(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          const r = await fetch("/api/logout", {
            method: "POST",
            headers: { "X-Workdeck-CSRF": me.csrf },
          });
          if (!r.ok) throw new Error(`logout ${r.status}`);
          return await disconnected;
        } finally {
          client.close();
        }
      }, workspace);
      expect(revoked).toBe(true);
      expect((await page.request.get("/api/me")).ok()).toBe(true);
    } finally {
      await separate.close();
    }
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
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("workspace displays direct file route and keeps editing available", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "file-direct-ui-"));
  writeFileSync(path.join(dir, "file.txt"), "before\n");
  let id = "",
    csrf = "";
  const name = `file direct ui ${Date.now()}`;
  try {
    await page.goto("/?file_transport=direct");
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
        if (!r.ok) throw new Error(`terminal ${r.status}`);
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
    await expect(page.locator(".file-network > summary")).toContainText(
      "直连",
      { timeout: 35000 },
    );
    await page.locator(".file-network > summary").click();
    await expect(page.locator(".file-network")).toContainText("中转延迟");
    await page.locator(".file-network > summary").click();
    await page.getByRole("button", { name: "file.txt", exact: true }).click();
    const editor = page.locator(".monaco-editor textarea.inputarea");
    await expect(editor).toBeAttached();
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("direct edit\n");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => readFileSync(path.join(dir, "file.txt"), "utf8"))
      .toBe("direct edit\n");
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
    rmSync(dir, { recursive: true, force: true });
  }
});
