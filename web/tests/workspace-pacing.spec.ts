import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);

test("terminal latency controls file pacing without blocking the terminal", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "pacing-ui-"));
  const name = `pacing fixture ${Date.now()}`;
  writeFileSync(path.join(dir, "large.txt"), "test content\n".repeat(22000));
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      (window as any).__probeCount = 0;
      (window as any).__delayedProbes = false;
      (window as any).__chunkTimes = [];
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes("/api/terminals/")) return;
          Object.defineProperty(this, "onmessage", {
            set: (handler: (event: MessageEvent) => void) => {
              this.addEventListener("message", (event) => {
                let probe = false;
                if (typeof event.data === "string") {
                  try {
                    probe = JSON.parse(event.data).type === "probe-reply";
                  } catch {}
                }
                if (probe) {
                  (window as any).__probeCount++;
                  if ((window as any).__delayedProbes) {
                    setTimeout(() => handler(event), 400);
                    return;
                  }
                }
                handler(event);
              });
            },
          });
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (
            this.url.includes("/api/workspaces/") &&
            typeof data === "string"
          ) {
            try {
              if (JSON.parse(data).type === "file.read.chunk")
                (window as any).__chunkTimes.push(performance.now());
            } catch {}
          }
          return super.send(data);
        }
      };
    });
    await page.goto("/?transport=relay");
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
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`terminal ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
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
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await expect
      .poll(() => page.evaluate(() => (window as any).__probeCount), {
        timeout: 18000,
      })
      .toBeGreaterThanOrEqual(3);
    await page.evaluate(() => {
      (window as any).__delayedProbes = true;
    });
    await expect(page.getByText("终端优先", { exact: false })).toBeVisible({
      timeout: 18000,
    });
    await page.getByRole("button", { name: "large.txt", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toBeVisible();
    const times: number[] = await page.evaluate(
      () => (window as any).__chunkTimes,
    );
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.slice(1).every((time, i) => time - times[i] >= 30)).toBe(true);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("printf '\\122\\105\\101\\104\\131\\n'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("READY");
    await page.evaluate(() => {
      (window as any).__delayedProbes = false;
    });
    await expect(page.getByText("终端优先", { exact: false })).toBeHidden({
      timeout: 22000,
    });
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
