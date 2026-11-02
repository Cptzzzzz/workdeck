import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test("relay output is delivered before optional WebRTC starts, including hidden tabs", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        'import { TerminalTransport } from "./src/terminal-transport"; globalThis.TestTerminalTransport = TerminalTransport;',
      resolveDir: path.resolve("."),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  await page.goto("about:blank");
  await page.evaluate(() => {
    (window as any).peerCount = 0;
    (window as any).isTerminalVisible = false;
    class FakeSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      binaryType = "";
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send() {}
      close() {
        this.readyState = 3;
      }
      receive(data: unknown) {
        this.onmessage?.({ data });
      }
    }
    (window as any).WebSocket = FakeSocket;
    (window as any).RTCPeerConnection = class {
      constructor() {
        (window as any).peerCount++;
        throw new Error("test peer");
      }
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const Transport = (window as any).TestTerminalTransport;
    const transport = new Transport(
      "ws://example.invalid",
      () => {},
      "node",
      undefined,
      "",
      () => (window as any).isTerminalVisible,
    );
    (window as any).transport = transport;
    (window as any).received = false;
    transport.onmessage = (event: { data: unknown }) => {
      if (event.data instanceof ArrayBuffer) (window as any).received = true;
    };
    transport.ws.receive(JSON.stringify({ type: "ready" }));
    transport.ws.receive(
      JSON.stringify({ type: "rtc-config", ice_servers: [] }),
    );
    transport.ws.receive(new Uint8Array([1]).buffer);
  });
  expect(await page.evaluate(() => (window as any).received)).toBe(true);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).peerCount)).toBe(0);
  await page.evaluate(() => (window as any).transport.outputRendered());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).peerCount)).toBe(0);
  await page.evaluate(() => {
    (window as any).isTerminalVisible = true;
    (window as any).transport.terminalVisible();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).peerCount))
    .toBe(1);
  await page.evaluate(() => (window as any).transport.close());
});

test("a stalled browser handshake races one replacement and only the winner starts a terminal", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        'import { TerminalTransport } from "./src/terminal-transport"; globalThis.TestTerminalTransport = TerminalTransport;',
      resolveDir: path.resolve("."),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  await page.goto("about:blank");
  await page.evaluate(() => {
    const all: any[] = [];
    (window as any).candidates = all;
    class Socket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      sent: string[] = [];
      onopen?: () => void;
      onclose?: () => void;
      constructor(public url: string) {
        all.push(this);
      }
      send(s: string) {
        this.sent.push(s);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
      open() {
        this.readyState = 1;
        this.onopen?.();
      }
    }
    (window as any).WebSocket = Socket;
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    (window as any).transport = new (window as any).TestTerminalTransport(
      "wss://example.invalid/api/terminals/test/ws",
      () => {},
      "node",
    );
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).candidates.length))
    .toBe(2);
  await page.evaluate(() => (window as any).candidates[1].open());
  expect(
    await page.evaluate(() =>
      (window as any).candidates.map((s: any) => ({
        state: s.readyState,
        sent: s.sent,
      })),
    ),
  ).toEqual([
    { state: 3, sent: [] },
    { state: 1, sent: ['{"type":"start"}'] },
  ]);
  await page.evaluate(() => {
    (window as any).candidates[0].open();
    (window as any).transport.close();
  });
  expect(
    await page.evaluate(() =>
      (window as any).candidates.every((s: any) => s.readyState === 3),
    ),
  ).toBe(true);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).candidates.length)).toBe(2);
});
