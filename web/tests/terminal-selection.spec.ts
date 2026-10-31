import { test, expect } from "@playwright/test";

for (const platform of ["Win32", "MacIntel"]) {
  test(`select and copy while TUI mouse mode is active (${platform})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", {
        value,
        configurable: true,
      });
    }, platform);
    await page.goto("/tests/fixtures/terminal-selection.html");
    await expect(page.locator(".xterm-screen")).toContainText(
      "COPY-ME-TERMINAL-TEXT",
    );
    const line = page.locator(".xterm-rows > div").first();
    const box = await line.boundingBox();
    if (!box) throw new Error("missing terminal line");
    const cell = box.width / 80;
    await page.locator("#outside").focus();
    await page.mouse.move(box.x + cell * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    // A TUI may redraw its text between mouse press and drag.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          (window as any).testTerminal.write(
            "\x1b[1;1HCOPY-ME-TERMINAL-TEXT",
            resolve,
          ),
        ),
    );
    await page.mouse.move(box.x + cell * 11.5, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testTerminal.getSelection()),
      )
      .toContain("COPY-ME");
    const second = await page.locator(".xterm-rows > div").nth(1).boundingBox();
    if (!second) throw new Error("missing second line");
    await page.mouse.move(box.x + cell * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + cell * 6, second.y + second.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testTerminal.getSelection()),
      )
      .toContain("\nsecond");
    await page.mouse.move(second.x + cell * 12, second.y + second.height / 2);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testTerminal.getSelection()),
      )
      .toContain("COPY-ME");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          (window as any).testTerminal.write("\x1b[?1003l\x1b[?1003h", resolve),
        ),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testTerminal.getSelection()),
      )
      .toContain("COPY-ME");
    await page.keyboard.press(platform === "MacIntel" ? "Meta+c" : "Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("COPY-ME");
    const before = await page.evaluate(() =>
      (window as any).testInputs.slice(),
    );
    expect(before).not.toContain("\x03");
    if (platform === "MacIntel") {
      await page.keyboard.press("Control+c");
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).testInputs.includes("\x03")),
        )
        .toBe(true);
      await page.evaluate(() => {
        (window as any).testInputs.length = 0;
      });
    }
    await page.evaluate(() => (window as any).testTerminal.clearSelection());
    await page.keyboard.press("Control+c");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testInputs.includes("\x03")),
      )
      .toBe(true);
    await page.evaluate(() => {
      (window as any).testInputs.length = 0;
    });
    await page.mouse.move(box.x + cell * 8, box.y + box.height / 2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).testInputs.some((s: string) =>
            s.startsWith("\x1b[<"),
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => {
      (window as any).testInputs.length = 0;
    });
    await page.mouse.click(box.x + cell * 4, box.y + box.height / 2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).testInputs.some((s: string) =>
            s.startsWith("\x1b[<"),
          ),
        ),
      )
      .toBe(true);
  });
}
