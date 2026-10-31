import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT;
const nodeName = process.env.WORKDECK_TEST_NODE_NAME;
const url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated node",
);

test("default direct preference uses the stable slower file peer", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "prefer-file-"));
  writeFileSync(path.join(dir, "sample.txt"), "direct file content\n");
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, options);
          if (label === "workdeck-file-control") {
            Object.defineProperty(channel, "onmessage", {
              set(handler: (event: MessageEvent) => void) {
                channel.addEventListener("message", (event) => {
                  let probe = false;
                  try {
                    probe = JSON.parse(event.data).type === "file.probe.reply";
                  } catch {}
                  if (probe) setTimeout(() => handler(event), 45);
                  else handler(event);
                });
              },
            });
          }
          return channel;
        }
      };
    });
    await page.goto("/");
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
        const me = await fetch("/api/me").then((r) => r.json());
        const state = await fetch("/api/state").then((r) => r.json());
        const node = state.nodes.find(
          (n: any) => n.name === nodeName && n.online,
        );
        if (!node) throw new Error("isolated node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({
            node_id: node.id,
            name: "file preference fixture",
            cwd: dir,
          }),
        });
        if (!response.ok) throw new Error(`create ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
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
    await page.reload();
    await page
      .getByRole("button", { name: "file preference fixture", exact: true })
      .click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(page.locator(".workbench-route")).toContainText(
      "WebRTC 直连",
      { timeout: 30000 },
    );
    await expect
      .poll(async () => {
        const title =
          (await page.locator(".workbench-route").getAttribute("title")) || "";
        const values = title.match(/中转 ([\d.]+) ms，直连 ([\d.]+) ms/);
        return values ? Number(values[2]) - Number(values[1]) : 0;
      })
      .toBeGreaterThan(20);
    await page.getByRole("button", { name: "sample.txt", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toContainText(
      "direct file content",
    );
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
