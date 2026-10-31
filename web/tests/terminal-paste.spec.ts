import { test, expect } from "@playwright/test";

for (const platform of ["Win32", "MacIntel"]) {
  test(`native text paste reaches terminal as clipboard text (${platform})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(
      (value) =>
        Object.defineProperty(navigator, "platform", {
          value,
          configurable: true,
        }),
      platform,
    );
    await page.goto("/tests/fixtures/terminal-selection.html");
    await expect(page.locator(".xterm-screen")).toContainText("COPY-ME");
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("PASTE-中文\nsecond line");
      (window as any).testInputs.length = 0;
      (window as any).testTerminal.focus();
      await new Promise<void>((resolve) =>
        (window as any).testTerminal.write("\x1b[?2004h", resolve),
      );
    });
    if (platform === "MacIntel") {
      // Linux Chromium cannot generate the macOS native paste shortcut. Check
      // that Meta+V is not forwarded, then deliver the browser paste event.
      await page.keyboard.press("Meta+v");
      expect(
        await page.evaluate(() => (window as any).testInputs.join("")),
      ).toBe("");
      await page.locator(".xterm-helper-textarea").evaluate((element) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "PASTE-中文\nsecond line");
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      });
    } else {
      await page.keyboard.press("Control+v");
    }
    await expect
      .poll(() => page.evaluate(() => (window as any).testInputs.join("")))
      .toBe("\x1b[200~PASTE-中文\rsecond line\x1b[201~");
  });
}
