import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readState, selectTestNode, terminateCurrentTerminal } from "./helpers";

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
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    (window as any).__peers = [];
    (window as any).__directBinary = 0;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        (window as any).__peers.push(this);
      }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        channel.addEventListener("message", (event) => {
          if (typeof event.data !== "string") (window as any).__directBinary++;
        });
        return channel;
      }
    };
  });
  await login(page);
  let relayBinary = 0,
    readyCount = 0;
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string") relayBinary++;
      else {
        try {
          if (JSON.parse(frame.payload).type === "ready") readyCount++;
        } catch {}
      }
    }),
  );
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
    await expect(page.locator(".transport-state")).toContainText("直连", {
      timeout: 25000,
    });
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
    // A separate authenticated device gets readonly access and can take over.
    const other = await browser.newContext();
    try {
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
      await expect(viewer.locator(".transport-state")).toContainText("直连", {
        timeout: 25000,
      });
      await viewer.evaluate(() => {
        for (const channel of (window as any).__channels)
          if (channel.readyState === "open")
            channel.send(
              new TextEncoder().encode(
                "export WORKDECK_READONLY_ATTACK=changed\n",
              ),
            );
      });
      await type(
        page,
        "printf 'readonly-marker=%s\\n' \"${WORKDECK_READONLY_ATTACK:-blocked}\"",
      );
      await expect(page.locator(".xterm-screen")).toContainText(
        "readonly-marker=blocked",
      );
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
      await expect(viewer.locator(".transport-state")).toContainText("直连", {
        timeout: 25000,
      });
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
    await page.getByRole("button", { name: "接管终端", exact: true }).click();
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect(page.locator(".transport-state")).toContainText("直连", {
      timeout: 25000,
    });
    await type(page, "export WORKDECK_ONCE=1; printf 'once-marker\\n'");
    await expect(page.locator(".xterm-screen")).toContainText("once-marker");
    const beforeReconnect = readyCount;
    await page.evaluate(() => {
      for (const peer of (window as any).__peers) peer.close();
    });
    await expect.poll(() => readyCount).toBeGreaterThan(beforeReconnect);
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect(page.locator(".transport-state")).toContainText("中转");
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
    await expect(page.locator(".transport-state")).toHaveAttribute(
      "title",
      /自动比较/,
    );
    await expect(page.locator(".transport-state")).toContainText("中转");
    await type(page, "printf 'better-relay-selected\\n'");
    await expect(page.locator(".xterm-screen")).toContainText(
      "better-relay-selected",
    );
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
    await expect(page.locator(".transport-state")).toContainText("中转");
    await type(page, "printf 'relay-only-works\\n'");
    await expect(page.locator(".xterm-screen")).toContainText(
      "relay-only-works",
    );
    await terminateCurrentTerminal(page);
  } finally {
    await cleanup(page, id);
  }
});
