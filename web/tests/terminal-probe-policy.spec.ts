import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test("settled direct sessions stop other probes; manual tests preserve the active route", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        'import {TerminalTransport} from "./src/terminal-transport";globalThis.Transport=TerminalTransport;',
      resolveDir: path.resolve("."),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  await page.route("http://127.0.0.1:5198/**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith("/probe-fixture")
        ? "text/html"
        : "application/json",
      body: route.request().url().endsWith("/probe-fixture")
        ? "<!doctype html>"
        : "{}",
    }),
  );
  await page.goto("http://127.0.0.1:5198/probe-fixture");
  await page.clock.install();
  await page.evaluate(() => {
    const counters = { relay: 0, direct: 0, peers: 0, switches: 0 };
    (window as any).counters = counters;
    class Channel {
      readyState = "connecting";
      bufferedAmount = 0;
      binaryType = "arraybuffer";
      onopen?: () => void;
      onmessage?: (e: any) => void;
      send(text: string) {
        const f = JSON.parse(text);
        if (f.type === "probe") {
          counters.direct++;
          this.onmessage?.({
            data: JSON.stringify({ type: "probe-reply", id: f.id }),
          });
        }
        if (f.type === "route-commit")
          this.onmessage?.({
            data: JSON.stringify({
              type: "route-active",
              id: f.id,
              route: "direct",
            }),
          });
      }
      close() {
        this.readyState = "closed";
      }
    }
    class Peer {
      connectionState = "connected";
      iceConnectionState = "connected";
      iceGatheringState = "complete";
      signalingState = "stable";
      localDescription: any;
      channel = new Channel();
      constructor() {
        counters.peers++;
      }
      createDataChannel() {
        return this.channel;
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(s: any) {
        this.localDescription = s;
      }
      async setRemoteDescription() {
        queueMicrotask(() => {
          this.channel.readyState = "open";
          this.channel.onopen?.();
        });
      }
      async getStats() {
        return new Map<string, any>([
          [
            "transport",
            {
              id: "transport",
              type: "transport",
              selectedCandidatePairId: "pair",
            },
          ],
          [
            "pair",
            {
              id: "pair",
              type: "candidate-pair",
              state: "succeeded",
              nominated: true,
              localCandidateId: "local",
              remoteCandidateId: "remote",
            },
          ],
          [
            "local",
            {
              id: "local",
              type: "local-candidate",
              candidateType: "host",
              address: "192.0.2.1",
            },
          ],
          [
            "remote",
            {
              id: "remote",
              type: "remote-candidate",
              candidateType: "host",
              address: "192.0.2.2",
            },
          ],
        ]);
      }
      close() {
        this.connectionState = "closed";
        this.channel.close();
      }
    }
    class Socket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (e: any) => void;
      onclose?: (e: any) => void;
      constructor() {
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
          this.reply({ type: "ready", readonly: false });
          this.reply({
            type: "rtc-config",
            ice_servers: [],
            rtc_trickle: true,
            rtc_paths: false,
          });
          this.onmessage?.({ data: new Uint8Array([65]).buffer });
        });
      }
      reply(f: any) {
        this.onmessage?.({ data: JSON.stringify(f) });
      }
      send(text: string) {
        const f = JSON.parse(text);
        if (f.type === "probe") {
          counters.relay++;
          this.reply({ type: "probe-reply", id: f.id });
        }
        if (f.type === "rtc-offer")
          this.reply({ type: "rtc-answer", sdp: "v=0\r\n" });
        if (f.type === "route-request") {
          counters.switches++;
          this.reply({ type: "route-ready", id: f.id, route: f.route });
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
      }
    }
    (window as any).WebSocket = Socket;
    (window as any).RTCPeerConnection = Peer;
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const t = new (window as any).Transport(
      "wss://example.invalid/api/terminals/test/ws",
      (s: any) => ((window as any).latestStatus = s),
      "node",
    );
    (window as any).transport = t;
    (window as any).closedCount = 0;
    t.onclose = () => {
      (window as any).closedCount++;
    };
    t.onmessage = (e: any) => {
      if (e.data instanceof ArrayBuffer) t.outputRendered();
    };
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).latestStatus.route))
    .toBe("direct")
    .catch(async (e) => {
      console.log(
        await page.evaluate(() => ({
          status: (window as any).latestStatus,
          counters: (window as any).counters,
          checking: (window as any).transport.checking,
          peer: (window as any).transport.peer?.connectionState,
        })),
      );
      throw e;
    });
  for (let i = 0; i < 6; i++) await page.clock.fastForward(5000);
  await expect
    .poll(() => page.evaluate(() => (window as any).latestStatus.discovery))
    .toBe("settled");
  const before = await page.evaluate(() => (window as any).counters);
  await page.clock.fastForward(65000);
  const after = await page.evaluate(() => (window as any).counters);
  expect(after.relay).toBe(before.relay);
  expect(after.direct).toBeGreaterThan(before.direct);
  expect(after.peers).toBe(1);
  await page.evaluate(() => (window as any).transport.testPath("websocket"));
  const tested = await page.evaluate(() => ({
    status: (window as any).latestStatus,
    counters: (window as any).counters,
  }));
  expect(tested.counters.relay).toBe(after.relay + 6);
  expect(tested.status.route).toBe("direct");
  expect(tested.status.manualTests.websocket.samples).toBe(6);
  expect(tested.counters.switches).toBe(1);
  await page.clock.fastForward(65000);
  expect(await page.evaluate(() => (window as any).counters.relay)).toBe(
    tested.counters.relay,
  );
  await page.evaluate(() => {
    const t = (window as any).transport;
    t.channel.onclose();
  });
  expect(await page.evaluate(() => (window as any).closedCount)).toBe(1);
});
