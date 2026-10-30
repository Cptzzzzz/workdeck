import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { selectTestNode, readState } from "./helpers";

for (const dpr of [1, 1.25, 2])
  test(`actual final ASCII and wide cells remain visible at DPR ${dpr}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    const password = readFileSync(
      process.env.WORKDECK_TEST_PASSWORD_FILE ||
        "../.secrets/administrator.txt",
      "utf8",
    ).trim();
    let id = "";
    const readings: any[] = [];
    try {
      await page.goto("/?transport=relay");
      await page.getByLabel("用户名").fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page
        .getByRole("button", { name: "新建终端", exact: true })
        .first()
        .click();
      await selectTestNode(page);
      const name = "右边界验收-" + Date.now();
      await page.getByLabel("终端名称").fill(name);
      await page.getByRole("button", { name: "创建并连接" }).click();
      await expect(page.locator(".terminal-state")).toContainText("控制中");
      id = (await readState(page)).terminals.find(
        (t: { name: string }) => t.name === name,
      ).id;
      const program =
        "import curses\ndef main(s):\n curses.start_color()\n curses.init_pair(1,curses.COLOR_RED,curses.COLOR_BLACK)\n curses.init_pair(2,curses.COLOR_GREEN,curses.COLOR_BLACK)\n s.timeout(50)\n while True:\n  h,w=s.getmaxyx();s.erase()\n  prefix='WIDTH=%d '%w\n  s.addstr(0,0,prefix+'-'*(w-len(prefix)-1)+'R')\n  s.addstr(1,0,'中'+'-'*(w-4)+'文')\n  s.addstr(2,0,'B'+'-'*(w-2)+'W',curses.A_BOLD)\n  for x in range(w):\n   s.addstr(3,x,'W',curses.color_pair(x%2+1))\n   s.addstr(4,x,'W',curses.A_BOLD if x%2 else 0)\n  s.addstr(5,0,'文'*(w//2)+('R' if w%2 else ''))\n  s.refresh()\n  if s.getch()==ord('q'):break\ncurses.wrapper(main)\n";
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.insertText(
        `python3 -c "exec(__import__('base64').b64decode('${Buffer.from(program).toString("base64")}'))"`,
      );
      await page.keyboard.press("Enter");
      for (const width of [1440, 1023, 391, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const font of ["10", "12", "13", "14", "18", "24"]) {
          await page
            .getByRole("button", { name: "终端字号", exact: true })
            .click();
          const settings = page.getByRole("dialog", { name: "终端字号设置" });
          await settings
            .getByRole("combobox", { name: "字号", exact: true })
            .selectOption(font);
          await settings.getByRole("button", { name: "关闭字号设置" }).click();
          await expect(page.locator(".xterm-rows > div").first()).toContainText(
            /WIDTH=\d+.*R$/,
          );
          const measure = () =>
            page.locator(".terminal-mount").evaluate((element) => {
              const grid = element.querySelector(".xterm-screen")!,
                viewport = element.querySelector(
                  ".xterm-viewport",
                ) as HTMLElement;
              const mount = element.getBoundingClientRect(),
                clip = grid.getBoundingClientRect(),
                scroll = viewport.getBoundingClientRect();
              const visibleRight = Math.min(
                mount.right,
                clip.right,
                scroll.left + viewport.clientWidth,
              );
              const declared = document
                .querySelector(".terminal-statusbar")
                ?.textContent?.match(/(\d+) × (\d+)/)?.[1];
              const cols = Number(declared);
              const rows = [...element.querySelectorAll(".xterm-rows > div")]
                .slice(0, 6)
                .map((row) => {
                  const walker = document.createTreeWalker(
                    row,
                    NodeFilter.SHOW_TEXT,
                  );
                  let node: Node | null,
                    last: Node | null = null,
                    offset = 0,
                    cell = 0;
                  while ((node = walker.nextNode())) {
                    for (let i = 0; i < (node.textContent?.length || 0); i++) {
                      cell +=
                        node.textContent![i] === "中" ||
                        node.textContent![i] === "文"
                          ? 2
                          : 1;
                      if (cell >= cols) {
                        last = node;
                        offset = i;
                        break;
                      }
                    }
                    if (last) break;
                  }
                  // A TUI redraw can lag a frontend resize. Alternate screen
                  // buffers may also retain cells beyond the current width.
                  let right = Number.POSITIVE_INFINITY;
                  if (last) {
                    const range = document.createRange();
                    range.setStart(last, offset);
                    range.setEnd(last, offset + 1);
                    right = range.getBoundingClientRect().right;
                  }
                  return {
                    text: row.textContent,
                    last: last?.textContent?.[offset] || "",
                    letterSpacing: getComputedStyle(row).letterSpacing,
                    right,
                    overflow: right - visibleRight,
                    rowRight: row.getBoundingClientRect().right,
                  };
                });
              return {
                font: getComputedStyle(element.querySelector(".xterm-rows")!)
                  .fontSize,
                declared,
                visibleRight,
                mountRight: mount.right,
                gridRight: clip.right,
                rows,
              };
            });
          await expect
            .poll(async () => {
              const m = await measure();
              if (m.rows.some((row) => !row.last)) return false;
              return m.rows[0].text?.match(/WIDTH=(\d+)/)?.[1] === m.declared;
            })
            .toBe(true);
          const reading = await measure();
          readings.push({ dpr, width, font, ...reading });
          await test.step(`width ${width}, font ${font}: last glyphs fit`, async () => {
            expect(reading.rows.map((r) => r.last)).toEqual([
              "R",
              "文",
              "W",
              "W",
              "W",
              Number(reading.declared) % 2 ? "R" : "文",
            ]);
            expect(
              Math.max(...reading.rows.map((r) => r.overflow)),
            ).toBeLessThanOrEqual(0.75);
          });
        }
      }
    } finally {
      writeFileSync(
        `../test-results/right-edge-${dpr}.json`,
        JSON.stringify(readings, null, 2),
      );
      await page
        .screenshot({ path: `../test-results/terminal-right-edge-${dpr}.png` })
        .catch(() => {});
      if (id)
        await page
          .evaluate(async (id) => {
            const me = await (await fetch("/api/me")).json();
            await fetch("/api/terminals/" + id, {
              method: "DELETE",
              headers: { "X-Workdeck-CSRF": me.csrf },
            });
          }, id)
          .catch(() => {});
      await context.close();
    }
  });
