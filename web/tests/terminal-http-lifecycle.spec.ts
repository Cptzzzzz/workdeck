import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { createServer, ServerResponse } from "node:http";

test("HTTP sessions isolate ordered input, retain quiet heartbeats, and close half-open streams", async ({
  page,
}) => {
  const streams = new Map<string, ServerResponse>();
  const received = new Map<string, string[]>();
  let released: (() => void) | undefined;
  let abortedPosts = 0;
  let pendingPosts = 0,
    maxPendingPosts = 0,
    closed = 0;
  const packet = (id: string, kind: number, data: string) =>
    streams
      .get(id)
      ?.write(
        `data: ${JSON.stringify({ kind, data: Buffer.from(data).toString("base64") })}\n\n`,
      );
  const server = createServer((req, res) => {
    if (req.url?.includes("/stream")) {
      const id = String(Number(req.url!.split("/")[3]) + 1).padStart(48, "0");
      streams.set(id, res);
      received.set(id, []);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Workdeck-Stream": id,
      });
      res.write(": connected\n\n");
      res.on("close", () => closed++);
      return;
    }
    if (req.method === "POST") {
      const id = req.url!.split("/")[3];
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        pendingPosts++;
        maxPendingPosts = Math.max(maxPendingPosts, pendingPosts);
        const messages = JSON.parse(body).packets.map((p: any) =>
          Buffer.from(p.data, "base64").toString(),
        );
        received.get(id)!.push(...messages);
        const finish = () => {
          pendingPosts--;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        };
        if (messages.includes("hold")) {
          released = finish;
          res.on("close", () => {
            if (!res.writableEnded) abortedPosts++;
          });
        } else finish();
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("missing fixture address");
  try {
    const bundle = await build({
      stdin: {
        contents:
          'import { HttpTerminalSocket } from "./src/http-terminal-socket"; globalThis.Socket=HttpTerminalSocket;',
        resolveDir: path.resolve("."),
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.clock.install();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      (window as any).messages = [[], []];
      (window as any).closes = [[], []];
      (window as any).sockets = [0, 1].map((i) => {
        const socket = new (window as any).Socket(
          new URL(
            location.origin.replace("http", "ws") + `/api/terminals/${i}/ws`,
          ),
        );
        socket.onmessage = (event: any) =>
          (window as any).messages[i].push(
            new TextDecoder().decode(event.data),
          );
        socket.onclose = (event: any) =>
          (window as any).closes[i].push(event.code);
        return socket;
      });
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).sockets.every((s: any) => s.readyState === 1),
        ),
      )
      .toBe(true);
    const ids = ["1".padStart(48, "0"), "2".padStart(48, "0")];
    await page.evaluate(() =>
      (window as any).sockets[0].send(new TextEncoder().encode("hold")),
    );
    await expect.poll(() => received.get(ids[0])!).toEqual(["hold"]);
    await page.evaluate(() => {
      for (const text of ["第二条 🙂", "third", "fourth"])
        (window as any).sockets[0].send(new TextEncoder().encode(text));
    });
    expect(received.get(ids[0])).toEqual(["hold"]);
    released!();
    await expect
      .poll(() => received.get(ids[0])!)
      .toEqual(["hold", "第二条 🙂", "third", "fourth"]);
    expect(maxPendingPosts).toBe(1);
    await page.evaluate(() =>
      (window as any).sockets[1].send(
        new TextEncoder().encode("other session"),
      ),
    );
    await expect.poll(() => received.get(ids[1])!).toEqual(["other session"]);
    await page.evaluate(() =>
      (window as any).sockets[0].send(new TextEncoder().encode("hold")),
    );
    await expect.poll(() => received.get(ids[0])!.at(-1)).toBe("hold");
    await page.evaluate(() => {
      (window as any).sockets[0].send(new TextEncoder().encode("never sent"));
      (window as any).sockets[0].close();
    });
    await expect.poll(() => abortedPosts).toBe(1);
    expect(received.get(ids[0])).not.toContain("never sent");
    await expect.poll(() => closed).toBe(1);
    // The server heartbeat alone keeps a quiet terminal alive past 45 seconds.
    for (let i = 0; i < 4; i++) {
      await page.clock.fastForward(15000);
      packet(ids[1], 0, "");
      await page.waitForTimeout(50);
      expect(
        await page.evaluate(() => (window as any).sockets[1].readyState),
      ).toBe(1);
    }
    expect(
      await page.evaluate(() => (window as any).sockets[1].readyState),
    ).toBe(1);
    await page.clock.fastForward(45001);
    await expect
      .poll(() => page.evaluate(() => (window as any).closes[1]))
      .toEqual([1006]);
    await expect.poll(() => closed).toBe(2);
    expect(await page.evaluate(() => (window as any).closes[0])).toEqual([
      1000,
    ]);
  } finally {
    for (const s of streams.values()) s.end();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
