import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readState, selectTestNode, terminateCurrentTerminal } from "./helpers";

async function assertLastRowFits(page: Page) {
  await expect(page.locator(".xterm-rows > div").last()).toContainText(
    "BOTTOM-ROW-VISIBLE",
  );
  await expect
    .poll(() =>
      page.locator(".terminal-screen").evaluate((element) => {
        const clip = element.getBoundingClientRect(),
          padding = getComputedStyle(element);
        const grid = element
          .querySelector(".xterm-screen")!
          .getBoundingClientRect();
        const last = element
          .querySelector(".xterm-rows")!
          .lastElementChild!.getBoundingClientRect();
        const footer = document
          .querySelector(
            ".terminal-workspace:not(.hidden) .terminal-statusbar",
          )!
          .getBoundingClientRect();
        return (
          last.bottom <=
            clip.bottom - parseFloat(padding.paddingBottom) + 0.5 &&
          grid.right <= clip.right - parseFloat(padding.paddingRight) + 0.5 &&
          last.bottom <= footer.top &&
          footer.bottom <= innerHeight + 0.5
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const row = await page.locator(".xterm-rows > div").last().boundingBox();
      if (!row) return false;
      return page.evaluate(
        ({ x, y }) =>
          !!document.elementFromPoint(x, y)?.closest(".terminal-screen"),
        { x: row.x + 20, y: row.y + row.height - 1 },
      );
    })
    .toBe(true);
}

test("last terminal row remains fully visible through resizing, network details and fullscreen", async ({
  page,
}) => {
  const password = readFileSync(
    process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
    "utf8",
  ).trim();
  await page.goto("/?transport=relay");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  const name = "末行布局验收-" + Date.now();
  await page.getByLabel("终端名称").fill(name);
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  const id = (await readState(page)).terminals.find(
    (t: { name: string }) => t.name === name,
  ).id;
  try {
    // Continuously paint a real TUI at the node's actual bottom row, including
    // after resize. DOM bounds alone must not hide a clipped application line.
    const program =
      "import curses\ndef main(s):\n s.timeout(100)\n while True:\n  rows,cols=s.getmaxyx()\n  s.erase();s.addstr(rows-1,0,'BOTTOM-ROW-VISIBLE'[:cols-1]);s.refresh()\n  if s.getch()==ord('q'):break\ncurses.wrapper(main)\n";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText(
      `python3 -c "exec(__import__('base64').b64decode('${Buffer.from(program).toString("base64")}'))"`,
    );
    await page.keyboard.press("Enter");
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1024, height: 640 },
      { width: 390, height: 844 },
      { width: 390, height: 600 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await test.step(`${viewport.width}x${viewport.height}: collapsed`, () =>
        assertLastRowFits(page));
      await page.locator(".terminal-network > summary").click();
      await test.step(`${viewport.width}x${viewport.height}: expanded`, () =>
        assertLastRowFits(page));
      await page.locator(".terminal-network > summary").click();
      await assertLastRowFits(page);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await assertLastRowFits(page);
    await page.screenshot({
      path: "../test-results/terminal-bottom-fullscreen.png",
    });
    await page.evaluate(() => document.exitFullscreen());
    await assertLastRowFits(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertLastRowFits(page);
    await page.screenshot({
      path: "../test-results/terminal-bottom-mobile.png",
    });
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("q");
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
