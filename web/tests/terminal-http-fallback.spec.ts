import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { createServer, ServerResponse } from "node:http";

test("HTTP stream renders and accepts input when every WebSocket handshake stalls", async ({
  page,
}) => {
  let stream: ServerResponse | undefined;
  let opened = 0,
    closed = 0,
    starts = 0;
  const packet = (kind: number, data: string) =>
    stream?.write(
      `data: ${JSON.stringify({ kind, data: Buffer.from(data).toString("base64") })}\n\n`,
    );
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/terminals/fixture/stream")) {
      opened++;
      stream = res;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Workdeck-Stream": "a".repeat(48),
      });
      res.flushHeaders();
      res.on("close", () => closed++);
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        const value = JSON.parse(body);
        for (const p of value.packets || []) {
          const text = Buffer.from(p.data, "base64").toString();
          if (p.kind === 1 && JSON.parse(text).type === "start") {
            starts++;
            packet(1, JSON.stringify({ type: "ready", readonly: false }));
            packet(2, "shell ready> ");
          } else if (p.kind === 2) packet(2, "echo:" + text);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><body></body>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("fixture address missing");
  try {
    const bundle = await build({
      stdin: {
        contents:
          'import { TerminalTransport } from "./src/terminal-transport"; globalThis.TestTerminalTransport=TerminalTransport;',
        resolveDir: path.resolve("."),
        loader: "ts",
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      write: false,
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(() => {
      (window as any).fakeSockets = [];
      class StalledSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = 0;
        onclose?: (event: { code: number }) => void;
        constructor() {
          (window as any).fakeSockets.push(this);
        }
        send() {
          throw Error("stalled WebSocket must not send terminal input");
        }
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 1000 });
        }
      }
      (window as any).WebSocket = StalledSocket;
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      (window as any).output = [];
      (window as any).statuses = [];
      const t = new (window as any).TestTerminalTransport(
        location.origin.replace("http", "ws") + "/api/terminals/fixture/ws",
        (status: any) => (window as any).statuses.push(status),
        "node",
      );
      (window as any).transport = t;
      t.onmessage = (event: any) => {
        if (event.data instanceof ArrayBuffer) {
          (window as any).output.push(new TextDecoder().decode(event.data));
          t.outputRendered();
        }
      };
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).output))
      .toContain("shell ready> ");
    await page.evaluate(() =>
      (window as any).transport.send(new TextEncoder().encode("hello")),
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).output))
      .toContain("echo:hello");
    expect(
      await page.evaluate(() => (window as any).statuses.at(-1).relayProtocol),
    ).toBe("http-stream");
    expect(
      await page.evaluate(
        () => (window as any).statuses.at(-1).relayCandidates.websocket.state,
      ),
    ).toBe("cancelled");
    expect(
      await page.evaluate(
        () =>
          (window as any).statuses.at(-1).relayCandidates["http-stream"].state,
      ),
    ).toBe("open");
    expect(starts).toBe(1);
    expect(opened).toBe(1);
    await page.evaluate(() => (window as any).transport.close());
    await expect.poll(() => closed).toBe(1);
    expect(
      await page.evaluate(() =>
        (window as any).fakeSockets.every((s: any) => s.readyState === 3),
      ),
    ).toBe(true);
  } finally {
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
