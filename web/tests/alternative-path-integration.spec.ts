import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  delayRelayProbesForDirectTest,
  readState,
  selectTestNode,
} from "./helpers";

test.skip(
  process.env.WORKDECK_DIRECT_ACCEPTANCE !== "1",
  "requires an isolated reachable node",
);

test("a faster independent candidate is promoted without replacing the terminal", async ({
  page,
}) => {
  const mode =
    process.env.WORKDECK_TEST_ALT_MODE === "tailnet" ? "tailnet" : "native";
  const fromDirect = process.env.WORKDECK_TEST_ALT_FROM_DIRECT === "1";
  await page.addInitScript(delayRelayProbesForDirectTest);
  await page.addInitScript(
    ({ mode, fromDirect }) => {
      const Native = window.RTCPeerConnection;
      let count = 0;
      window.RTCPeerConnection = class extends Native {
        private readonly primary = ++count === 1;
        constructor(config?: RTCConfiguration) {
          super(config);
          ((window as any).__pathPeers ||= []).push(this);
        }
        async getStats(
          selector?: MediaStreamTrack | null,
        ): Promise<RTCStatsReport> {
          const original = await super.getStats(selector);
          if (!this.primary) return original;
          const stats = new Map(
            Array.from(original.entries()).map(([k, v]) => [k, { ...v }]),
          );
          for (const value of stats.values()) {
            if (value.type === "transport" && value.selectedCandidatePairId) {
              const pair = stats.get(value.selectedCandidatePairId);
              const remote = pair && stats.get(pair.remoteCandidateId);
              if (remote)
                remote.address =
                  mode === "native" ? "100.64.0.1" : "192.168.1.1";
            }
          }
          return stats as unknown as RTCStatsReport;
        }
        createDataChannel(
          label: string,
          options?: RTCDataChannelInit,
        ): RTCDataChannel {
          const channel = super.createDataChannel(label, options);
          if (this.primary && label === "workdeck") {
            const send = channel.send.bind(channel);
            channel.send = ((data: any) => {
              let probe = false;
              try {
                probe =
                  typeof data === "string" && JSON.parse(data).type === "probe";
              } catch {}
              if (probe)
                setTimeout(
                  () => {
                    if (channel.readyState === "open") send(data);
                  },
                  fromDirect ? 12 : 150,
                );
              else send(data);
            }) as typeof channel.send;
          }
          return channel;
        }
      };
    },
    { mode, fromDirect },
  );
  const seen: string[] = [];
  let readyCount = 0;
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        if (JSON.parse(payload).type === "ready") readyCount++;
      } catch {}
    });
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const x = JSON.parse(payload);
        if (x.type?.startsWith("rtc-path-") || x.type === "route-request")
          seen.push(x.type + (x.route ? ":" + x.route : ""));
      } catch {}
    });
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(
      readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE!, "utf8").trim(),
    );
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  const name = "候选链路测试-" + Date.now();
  await page.getByLabel("终端名称").fill(name);
  await page.getByRole("button", { name: "创建并连接" }).click();
  const id = (await readState(page)).terminals.find(
    (t: { name: string }) => t.name === name,
  ).id;
  try {
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect
      .poll(() => seen.includes("rtc-path-offer:" + mode), { timeout: 30000 })
      .toBe(true);
    if (fromDirect)
      await expect.poll(() => seen.includes("route-request:direct")).toBe(true);
    await expect
      .poll(() => seen.includes("rtc-path-promote"), { timeout: 35000 })
      .toBe(true);
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebRTC",
      { timeout: 20000 },
    );
    await page
      .locator(".terminal-workspace:not(.hidden) .xterm-helper-textarea")
      .focus();
    await page.keyboard.insertText(
      "export WORKDECK_ALT_MARKER=preserved; printf 'alternate-path-works\\n'",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-screen")).toContainText(
      "alternate-path-works",
    );
    const beforeReconnect = readyCount;
    await page.evaluate(() => (window as any).__pathPeers.at(-1).close());
    await expect
      .poll(() => readyCount, { timeout: 25000 })
      .toBeGreaterThan(beforeReconnect);
    await expect(page.locator(".terminal-state")).toContainText("控制中", {
      timeout: 25000,
    });
    await page
      .locator(".terminal-workspace:not(.hidden) .xterm-helper-textarea")
      .focus();
    await page.keyboard.insertText(
      "printf 'path-fallback=%s\\n' \"$WORKDECK_ALT_MARKER\"",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-screen")).toContainText(
      "path-fallback=preserved",
      { timeout: 25000 },
    );
  } finally {
    await page.evaluate(async (terminal) => {
      const me = await fetch("/api/me").then((r) => r.json());
      await fetch(`/api/terminals/${terminal}`, {
        method: "DELETE",
        headers: { "X-Workdeck-CSRF": me.csrf },
      });
    }, id);
  }
});
