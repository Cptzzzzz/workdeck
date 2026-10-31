import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  readState,
  selectTestNode,
  terminateCurrentTerminal,
  delayRelayProbesForDirectTest,
} from "./helpers";

const password = readFileSync(
  process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
  "utf8",
).trim();
async function type(page: Page, command: string) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}
async function lastLine(page: Page) {
  return (
    (await page.locator(".xterm-rows > div").allTextContents())
      .filter((line) => line.trim())
      .at(-1) || ""
  );
}
async function wheel(page: Page, delta: number, count = 4) {
  const bounds = await page.locator(".xterm-screen").boundingBox();
  if (!bounds) throw new Error("terminal is not visible");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  for (let i = 0; i < count; i++) await page.mouse.wheel(0, delta);
}

for (const route of ["relay", "direct"] as const)
  test(`wheel scrolls tmux history while keyboard arrows retain command history (${route})`, async ({
    page,
  }) => {
    test.skip(
      route === "direct" && process.env.WORKDECK_DIRECT_ACCEPTANCE !== "1",
      "requires a directly reachable Agent",
    );
    if (route === "direct")
      await page.addInitScript(delayRelayProbesForDirectTest);
    await page.addInitScript(() => {
      (window as any).__scrollInputs = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: any) {
        if (typeof data !== "string")
          (window as any).__scrollInputs.push(new TextDecoder().decode(data));
        return send.call(this, data);
      };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, options),
            send = channel.send.bind(channel);
          channel.send = ((data: any) => {
            if (typeof data !== "string")
              (window as any).__scrollInputs.push(
                new TextDecoder().decode(data),
              );
            send(data);
          }) as typeof channel.send;
          return channel;
        }
      };
    });
    await page.goto(route === "relay" ? "/?transport=relay" : "/");
    await page.getByLabel("用户名").fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page
      .getByRole("button", { name: "新建终端", exact: true })
      .first()
      .click();
    await selectTestNode(page);
    const name = "滚动验收-" + route + "-" + Date.now();
    await page.getByLabel("终端名称").fill(name);
    await page.getByRole("button", { name: "创建并连接" }).click();
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    const id = (await readState(page)).terminals.find(
      (t: { name: string }) => t.name === name,
    ).id;
    try {
      if (route === "direct")
        await expect(page.locator(".terminal-network > summary")).toContainText(
          "WebRTC",
          {
            timeout: 25000,
          },
        );
      await type(page, "bash --noprofile --norc");
      await type(page, "PS1='scroll$ '; HISTFILE=/dev/null; history -c");
      const program = "for i in range(200): print('SCROLL-LINE-%03d'%i)";
      await type(
        page,
        `python3 -c "exec(__import__('base64').b64decode('${Buffer.from(program).toString("base64")}'))"`,
      );
      await type(page, "printf 'HISTORY-A\\n'");
      await type(page, "printf 'HISTORY-B\\n'");
      await expect(page.locator(".xterm-screen")).toContainText("HISTORY-B");
      const draft = "draft-stays-unchanged";
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.insertText(draft);
      await expect.poll(() => lastLine(page)).toContain(draft);
      const visibleStart = Number(
        (await page.locator(".xterm-screen").innerText()).match(
          /SCROLL-LINE-(\d+)/,
        )?.[1],
      );
      await page.evaluate(() => {
        (window as any).__scrollInputs = [];
      });
      await wheel(page, -120, 6);
      await expect
        .poll(async () => {
          const first = (await page.locator(".xterm-screen").innerText()).match(
            /SCROLL-LINE-(\d+)/,
          );
          return first ? Number(first[1]) : 999;
        })
        .toBeLessThan(visibleStart);
      const reports = await page.evaluate(
        () => (window as any).__scrollInputs as string[],
      );
      expect(reports.length).toBeGreaterThan(0);
      for (const report of reports) {
        expect(report).not.toMatch(/\x1b(?:\[|O)[AB]/);
        expect(report).toMatch(/\x1b(?:\[<|\[M)/);
      }
      await page.screenshot({
        path: `../test-results/terminal-history-${route}.png`,
      });
      await wheel(page, 120, 20);
      await expect.poll(() => lastLine(page)).toContain(draft);
      await wheel(page, -120, 4);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(() => lastLine(page))
        .toContain("printf 'HISTORY-B\\n'");
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(() => lastLine(page))
        .toContain("printf 'HISTORY-A\\n'");
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => lastLine(page))
        .toContain("printf 'HISTORY-B\\n'");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => lastLine(page)).toContain(draft);
      await wheel(page, -120, 4);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.insertText("-suffix");
      await expect.poll(() => lastLine(page)).toContain(draft + "-suffix");
      await page.keyboard.press("Control+c");
      await type(page, "printf 'after-scroll-input-ok\\n'");
      await expect(page.locator(".xterm-screen")).toContainText(
        "after-scroll-input-ok",
      );
      // A reconnect must still scroll the node's retained history, rather than
      // relying on a browser-only cache of earlier output.
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".terminal-state")).toContainText("控制中");
      await wheel(page, -120, 6);
      await expect(page.locator(".xterm-screen")).toContainText(/SCROLL-LINE-/);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(() => lastLine(page))
        .toContain("printf 'after-scroll-input-ok\\n'");
      await page.keyboard.press("Control+c");
      // Fullscreen programs with mouse support keep receiving wheel reports,
      // and actual Up remains an application cursor key.
      const tui =
        "import curses\ndef main(s):\n curses.mousemask(curses.ALL_MOUSE_EVENTS)\n mice=arrows=0\n while True:\n  s.erase();s.addstr(0,0,'TUI mouse=%d arrows=%d'%(mice,arrows));s.refresh()\n  key=s.getch()\n  if key==curses.KEY_MOUSE:\n   curses.getmouse();mice+=1\n  elif key==curses.KEY_UP: arrows+=1\n  elif key==ord('q'): break\ncurses.wrapper(main)\n";
      await type(
        page,
        `python3 -c "exec(__import__('base64').b64decode('${Buffer.from(tui).toString("base64")}'))"`,
      );
      await expect(page.locator(".xterm-screen")).toContainText(
        "TUI mouse=0 arrows=0",
      );
      await wheel(page, -120, 1);
      await expect(page.locator(".xterm-screen")).toContainText(
        /TUI mouse=[1-9]\d* arrows=0/,
      );
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("ArrowUp");
      await expect(page.locator(".xterm-screen")).toContainText(/arrows=1/);
      await page.keyboard.press("q");
      await expect.poll(() => lastLine(page)).toContain("scroll$");
      await terminateCurrentTerminal(page);
    } finally {
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
  });
