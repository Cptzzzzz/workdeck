import { selectThemedOption } from "./helpers";
import { test, expect, Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  readState,
  selectTestNode,
  terminateCurrentTerminal,
  delayRelayProbesForDirectTest,
} from "./helpers";
import { formatBytes } from "../src/network-metrics";

const password = readFileSync(
  process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
  "utf8",
).trim();
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "你的远程工作台." }),
  ).toBeVisible();
}
async function create(page: Page) {
  const name = "链路验收-" + Date.now();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  await page.getByLabel("终端名称").fill(name);
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  return (await readState(page)).terminals.find(
    (t: { name: string }) => t.name === name,
  ).id as string;
}
async function type(page: Page, command: string) {
  await page
    .locator(".terminal-workspace:not(.hidden) .xterm-helper-textarea")
    .focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}
async function cleanup(page: Page, id: string) {
  await page
    .evaluate(async (id) => {
      const me = await (await fetch("/api/me")).json();
      await fetch("/api/terminals/" + id, {
        method: "DELETE",
        headers: { "X-Workdeck-CSRF": me.csrf },
        signal: AbortSignal.timeout(10000),
      });
    }, id)
    .catch(() => {});
}

test("automatic direct path carries terminal bytes; failure falls back without replay", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.WORKDECK_DIRECT_ACCEPTANCE !== "1",
    "requires a directly reachable test Agent",
  );
  if (process.env.WORKDECK_ICE_TRACE_LEGACY === "1") {
    await page.setExtraHTTPHeaders({
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140",
    });
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          try {
            const msg = JSON.parse(data);
            if (msg.type === "rtc-offer") {
              delete msg.rtc_trace_requested;
              data = JSON.stringify(msg);
            }
          } catch {}
        }
        return send.call(this, data);
      };
    });
  }
  await page.addInitScript(delayRelayProbesForDirectTest);
  if (process.env.WORKDECK_ICE_TRACE_TEST_DIR) {
    await page.setExtraHTTPHeaders({
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140",
    });
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "userAgent", {
        get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140",
      }),
    );
  }
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    (window as any).__peers = [];
    (window as any).__directBinary = 0;
    (window as any).__directReceived = 0;
    (window as any).__directSent = 0;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        (window as any).__peers.push(this);
      }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        channel.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            (window as any).__directBinary++;
            (window as any).__directReceived += event.data.byteLength;
          }
        });
        const originalSend = channel.send.bind(channel);
        channel.send = ((data: any) => {
          if (typeof data !== "string")
            (window as any).__directSent += data.byteLength;
          originalSend(data);
        }) as typeof channel.send;
        return channel;
      }
    };
  });
  const beforeTraceFiles = new Set<string>();
  if (process.env.WORKDECK_ICE_TRACE_TEST_DIR) {
    try {
      for (const name of readdirSync(process.env.WORKDECK_ICE_TRACE_TEST_DIR))
        beforeTraceFiles.add(name);
    } catch {}
  }
  await login(page);
  let relayBinary = 0,
    readyCount = 0,
    browserCandidates = 0,
    nodeCandidates = 0,
    trickleOffer = false;
  let nodeDiagnostic: Record<string, any> | undefined;
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const payload = JSON.parse(frame.payload);
        if (payload.type === "rtc-offer" && payload.rtc_trickle === true)
          trickleOffer = true;
        if (payload.type === "rtc-candidate" && payload.candidate?.candidate)
          browserCandidates++;
      } catch {}
    });
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string") relayBinary++;
      else {
        try {
          const payload = JSON.parse(frame.payload);
          if (payload.type === "ready") readyCount++;
          if (payload.type === "rtc-diagnostic")
            nodeDiagnostic = payload.node_diagnostic;
          if (payload.type === "rtc-candidate" && payload.candidate?.candidate)
            nodeCandidates++;
        } catch {}
      }
    });
  });
  const id = await create(page);
  try {
    await type(
      page,
      "export WORKDECK_LINK_MARKER=kept; printf 'before-direct\\n'",
    );
    await expect(page.locator(".xterm-screen")).toContainText("before-direct");
    const stream =
      "import time\nfor i in range(12):\n print('handover-%02d'%i,flush=True)\n time.sleep(.1)\n";
    await type(
      page,
      `python3 -u -c "exec(__import__('base64').b64decode('${Buffer.from(stream).toString("base64")}'))"`,
    );
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebRTC",
      {
        timeout: 25000,
      },
    );
    if (process.env.WORKDECK_TRICKLE_ACCEPTANCE === "1") {
      expect(trickleOffer).toBe(true);
      await expect.poll(() => browserCandidates).toBeGreaterThan(0);
      await expect.poll(() => nodeCandidates).toBeGreaterThan(0);
    }
    if (process.env.WORKDECK_NODE_DIAGNOSTIC_ACCEPTANCE === "1") {
      await expect
        .poll(() => nodeDiagnostic?.remoteApplied ?? 0)
        .toBeGreaterThan(0);
      expect(nodeDiagnostic!.pairs.length).toBeGreaterThan(0);
      expect(
        Object.keys(nodeDiagnostic!.localCandidates).length,
      ).toBeGreaterThan(0);
      expect(nodeDiagnostic).toMatchObject({
        gathering: expect.any(String),
        ice: expect.any(String),
        localCandidates: expect.any(Object),
        pairs: expect.any(Array),
      });
      const keys = Object.keys(nodeDiagnostic!).sort();
      expect(keys).toEqual(
        [
          "connection",
          "gathering",
          "ice",
          "localCandidates",
          "pairs",
          "remoteApplied",
          "remoteCandidates",
          "remotePending",
          "remoteReceived",
          "remoteRejected",
          "sampleMs",
          "stunServers",
          ...(process.env.WORKDECK_ICE_TRACE_TEST_DIR ? ["wire"] : []),
        ].sort(),
      );
    }
    if (process.env.WORKDECK_ICE_TRACE_TEST_DIR) {
      const dir = process.env.WORKDECK_ICE_TRACE_TEST_DIR;
      await expect
        .poll(
          () => {
            try {
              const lines = readdirSync(dir)
                .filter((name) => !beforeTraceFiles.has(name))
                .flatMap((name) =>
                  readFileSync(`${dir}/${name}`, "utf8")
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((x) => JSON.parse(x)),
                );
              return (
                lines.some((x) => x.side === "browser") &&
                lines.some(
                  (x) => x.side === "node" && x.node?.wire?.requestsSent > 0,
                )
              );
            } catch {
              return false;
            }
          },
          { timeout: 15000 },
        )
        .toBe(true);
    }
    await expect(page.locator(".xterm-screen")).toContainText("handover-11");
    const screen = await page.locator(".xterm-screen").innerText();
    for (let i = 0; i < 12; i++)
      expect(
        screen.split(`handover-${String(i).padStart(2, "0")}`).length - 1,
      ).toBe(1);
    const relayAtStart = relayBinary;
    const directAtStart = await page.evaluate(
      () => (window as any).__directBinary,
    );
    await type(page, "printf 'direct-marker=%s\\n' \"$WORKDECK_LINK_MARKER\"");
    await expect(page.locator(".xterm-screen")).toContainText(
      "direct-marker=kept",
    );
    expect(relayBinary).toBe(relayAtStart);
    expect(
      await page.evaluate(() => (window as any).__directBinary),
    ).toBeGreaterThan(directAtStart);
    const network = page.locator(".terminal-network");
    await expect(network.locator('summary [data-path="direct"]')).toContainText(
      /ms/,
    );
    await network.locator(":scope > summary").click();
    await expect(
      network
        .getByRole("region", { name: "WebSocket 中转指标" })
        .locator(".network-latency"),
    ).toContainText(/ms/);
    await expect(
      network
        .getByRole("region", { name: "WebRTC 直连指标" })
        .locator(".network-latency"),
    ).toContainText(/ms/);
    await expect(network.locator(".network-current-route")).toHaveAttribute(
      "data-route",
      "direct",
    );
    await expect(network.locator(".network-current-route")).toContainText(
      "WebRTC 直连",
    );
    await expect(network.locator(".network-current-route")).not.toContainText(
      "公网主服务",
    );
    const trafficProgram =
      "import sys,time\nfor i in range(25):\n print('network-data-'+('x'*1000),flush=True)\n time.sleep(.1)\nprint('network-traffic-done',flush=True)\n";
    await type(
      page,
      `python3 -u -c "exec(__import__('base64').b64decode('${Buffer.from(trafficProgram).toString("base64")}'))"`,
    );
    await expect(
      network
        .getByRole("region", { name: "WebRTC 直连指标" })
        .getByText("下行速率", { exact: true })
        .locator("..")
        .locator("dd"),
    ).not.toHaveText("0 B/s");
    await expect(page.locator(".xterm-screen")).toContainText(
      "network-traffic-done",
    );
    const directCard = network.getByRole("region", { name: "WebRTC 直连指标" });
    const downloaded = directCard
      .getByText("累计下行", { exact: true })
      .locator("..")
      .locator("dd");
    const uploaded = directCard
      .getByText("累计上行", { exact: true })
      .locator("..")
      .locator("dd");
    await expect
      .poll(async () => {
        const count = await page.evaluate(
          () => (window as any).__directReceived,
        );
        return (await downloaded.textContent()) === formatBytes(count);
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const count = await page.evaluate(() => (window as any).__directSent);
        return (await uploaded.textContent()) === formatBytes(count);
      })
      .toBe(true);
    const relayCard = network.getByRole("region", {
      name: "WebSocket 中转指标",
    });
    const probeTime = Number(await relayCard.getAttribute("data-updated-at"));
    await expect
      .poll(async () => Number(await relayCard.getAttribute("data-updated-at")))
      .toBeGreaterThan(probeTime);
    await page.screenshot({
      path: "../test-results/network-metrics-desktop.png",
    });
    await network.locator(":scope > summary").click();
    // A separate authenticated device gets readonly access and can take over.
    const other = await browser.newContext();
    try {
      await other.addInitScript(delayRelayProbesForDirectTest);
      await other.addInitScript(() => {
        const Native = window.RTCPeerConnection;
        (window as any).__channels = [];
        (window as any).__peers = [];
        window.RTCPeerConnection = class extends Native {
          constructor(config?: RTCConfiguration) {
            super(config);
            (window as any).__peers.push(this);
          }
          createDataChannel(label: string, options?: RTCDataChannelInit) {
            const channel = super.createDataChannel(label, options);
            (window as any).__channels.push(channel);
            return channel;
          }
        };
      });
      const viewer = await other.newPage();
      await viewer.bringToFront();
      await login(viewer);
      const name = (await readState(page)).terminals.find(
        (t: { id: string }) => t.id === id,
      ).name;
      await viewer
        .locator(".terminal-card")
        .filter({ has: viewer.getByRole("heading", { name, exact: true }) })
        .getByRole("button", { name, exact: true })
        .click();
      await expect(viewer.locator(".terminal-state")).toContainText("只读连接");
      await expect(viewer.locator(".terminal-network > summary")).toContainText(
        "WebRTC",
        {
          timeout: 25000,
        },
      );
      await viewer.evaluate(() => {
        for (const channel of (window as any).__channels)
          if (channel.readyState === "open")
            channel.send(
              new TextEncoder().encode(
                "export WORKDECK_READONLY_ATTACK=changed\n",
              ),
            );
      });
      await page.bringToFront();
      await type(
        page,
        "printf 'readonly-marker=%s\\n' \"${WORKDECK_READONLY_ATTACK:-blocked}\"",
      );
      await expect(page.locator(".xterm-screen")).toContainText(
        "readonly-marker=blocked",
      );
      await viewer.bringToFront();
      await viewer
        .getByRole("button", { name: "接管终端", exact: true })
        .click();
      await expect(viewer.locator(".terminal-state")).toContainText("控制中");
      await expect(page.locator(".terminal-state")).toContainText("只读连接");
      await type(
        viewer,
        "printf 'takeover-marker=%s\\n' \"$WORKDECK_LINK_MARKER\"",
      );
      await expect(viewer.locator(".xterm-screen")).toContainText(
        "takeover-marker=kept",
      );
      await expect(viewer.locator(".terminal-network > summary")).toContainText(
        "WebRTC",
        {
          timeout: 25000,
        },
      );
      await viewer.evaluate(async () => {
        const me = await (await fetch("/api/me")).json();
        await fetch("/api/logout", {
          method: "POST",
          headers: { "X-Workdeck-CSRF": me.csrf },
        });
      });
      await expect
        .poll(() =>
          viewer.evaluate(() =>
            (window as any).__peers.every(
              (peer: RTCPeerConnection) => peer.connectionState === "closed",
            ),
          ),
        )
        .toBe(true);
    } finally {
      await other.close();
    }
    await page.bringToFront();
    await page.getByRole("button", { name: "接管终端", exact: true }).click();
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebRTC",
      {
        timeout: 25000,
      },
    );
    await type(page, "export WORKDECK_ONCE=1; printf 'once-marker\\n'");
    await expect(page.locator(".xterm-screen")).toContainText("once-marker");
    const beforeReconnect = readyCount;
    await page.evaluate(() => {
      for (const peer of (window as any).__peers) peer.close();
    });
    await expect.poll(() => readyCount).toBeGreaterThan(beforeReconnect);
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebSocket",
    );
    await type(
      page,
      'printf \'fallback-marker=%s:%s\\n\' "$WORKDECK_LINK_MARKER" "$WORKDECK_ONCE"',
    );
    await expect(page.locator(".xterm-screen")).toContainText(
      "fallback-marker=kept:1",
    );
    const state = await readState(page);
    expect(
      state.terminals.find((t: { id: string }) => t.id === id)?.state,
    ).toBe("running");
    await page.screenshot({ path: "../test-results/adaptive-fallback.png" });
    await terminateCurrentTerminal(page);
  } finally {
    await cleanup(page, id);
  }
});

test("a working but slower direct path leaves terminal traffic on the relay", async ({
  page,
}) => {
  test.skip(
    process.env.WORKDECK_DIRECT_ACCEPTANCE !== "1",
    "requires a directly reachable test Agent",
  );
  await page.addInitScript(() => {
    localStorage.setItem("workdeck.transport.preference.v1", "balanced");
    (window as any).__directReplies = 0;
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        Object.defineProperty(channel, "onmessage", {
          set(handler: (event: MessageEvent) => void) {
            channel.addEventListener("message", (event) => {
              let probe = false;
              if (typeof event.data === "string") {
                try {
                  probe = JSON.parse(event.data).type === "probe-reply";
                } catch {}
              }
              if (probe) {
                (window as any).__directReplies++;
                setTimeout(() => handler(event), 180);
              } else handler(event);
            });
          },
        });
        return channel;
      }
    };
  });
  await login(page);
  const id = await create(page);
  try {
    await expect
      .poll(() => page.evaluate(() => (window as any).__directReplies))
      .toBeGreaterThanOrEqual(6);
    await expect(page.locator(".terminal-network > summary")).toHaveAttribute(
      "title",
      /自动比较/,
    );
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebSocket",
    );
    const network = page.locator(".terminal-network");
    await network.locator(":scope > summary").click();
    await expect(network.locator(".network-current-route")).toHaveAttribute(
      "data-route",
      "relay",
    );
    await expect(network.locator(".network-comparison")).toContainText(
      /WebRTC 比 WebSocket 高/,
    );
    await page.screenshot({
      path: "../test-results/network-metrics-comparison.png",
    });
    await network.locator(":scope > summary").click();
    await type(page, "printf 'better-relay-selected\\n'");
    await expect(page.locator(".xterm-screen")).toContainText(
      "better-relay-selected",
    );
    await terminateCurrentTerminal(page);
  } finally {
    await cleanup(page, id);
  }
});

test("switching to direct preference moves a stable slower path without restarting the session", async ({
  page,
}) => {
  test.skip(
    process.env.WORKDECK_DIRECT_ACCEPTANCE !== "1",
    "requires a directly reachable test Agent",
  );
  await page.addInitScript(() => {
    localStorage.setItem("workdeck.transport.preference.v1", "balanced");
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        Object.defineProperty(channel, "onmessage", {
          set(handler: (event: MessageEvent) => void) {
            channel.addEventListener("message", (event) => {
              let probe = false;
              try {
                probe = JSON.parse(event.data).type === "probe-reply";
              } catch {}
              if (probe) setTimeout(() => handler(event), 45);
              else handler(event);
            });
          },
        });
        return channel;
      }
    };
  });
  let attachments = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes("/api/terminals/")) attachments++;
  });
  await login(page);
  const id = await create(page);
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
  try {
    const network = page.locator(".terminal-network");
    await expect(network.locator(":scope > summary")).toHaveAttribute(
      "title",
      /自动比较/,
      { timeout: 25000 },
    );
    await expect(network.locator(":scope > summary")).toContainText(
      "WebSocket",
    );
    await network.locator(":scope > summary").click();
    await selectThemedOption(network.getByLabel("链路策略"), "prefer-direct");
    await expect(network.getByLabel("链路策略")).toHaveAttribute(
      "data-value",
      "prefer-direct",
    );
    await page.waitForTimeout(200);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(network.locator(":scope > summary")).toContainText("WebRTC", {
      timeout: 25000,
    });
    await type(page, "printf 'direct-preference-session-kept\\n'");
    await expect(page.locator(".xterm-screen")).toContainText(
      "direct-preference-session-kept",
    );
    expect(pane()).toBe(pid);
    expect(attachments).toBe(1);
    await terminateCurrentTerminal(page);
  } finally {
    await cleanup(page, id);
  }
});

test("a browser without WebRTC keeps a usable relay terminal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  await login(page);
  const id = await create(page);
  try {
    await expect(page.locator(".terminal-network > summary")).toContainText(
      "WebSocket",
    );
    const network = page.locator(".terminal-network");
    await expect(network.locator('summary [data-path="relay"]')).toContainText(
      /ms/,
    );
    await network.locator(":scope > summary").click();
    await expect(
      network.getByRole("region", { name: "WebRTC 直连指标" }),
    ).toContainText("不支持");
    await expect(network.locator(".network-current-route")).toHaveAttribute(
      "data-route",
      "relay",
    );
    await expect(network.locator(".network-current-route")).toContainText(
      "公网主服务",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page
          .locator(".sidebar")
          .evaluate((element) => element.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(0);
    await page.screenshot({
      path: "../test-results/network-metrics-mobile.png",
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await network.locator(":scope > summary").click();
    await type(page, "printf 'relay-only-works\\n'");
    await expect(page.locator(".xterm-screen")).toContainText(
      "relay-only-works",
    );
    await terminateCurrentTerminal(page);
  } finally {
    await cleanup(page, id);
  }
});
