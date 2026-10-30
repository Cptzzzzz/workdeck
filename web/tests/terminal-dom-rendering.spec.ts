import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This renderer regression runs without a Hub or a compute node. Each ANSI
// character becomes a separate span, exposing cumulative inline layout error.
for (const dpr of [1, 1.25, 1.5, 2]) {
  test(`styled terminal runs align with logical cells at DPR ${dpr}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: dpr });
    try {
      const page = await context.newPage();
      await page.setContent(
        '<div id="terminal" style="width:1600px;height:800px"></div>',
      );
      const root = new URL("../node_modules/@xterm/xterm/", import.meta.url);
      await page.addStyleTag({
        content: readFileSync(new URL("css/xterm.css", root), "utf8"),
      });
      await page.addScriptTag({
        path: fileURLToPath(new URL("lib/xterm.js", root)),
      });
      for (const family of [
        '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        '"DejaVu Sans Mono", monospace',
        "monospace",
      ]) {
        for (const fontSize of [10, 12, 13, 14, 18, 24]) {
          const errors = await page.evaluate(
            async ({ family, fontSize }) => {
              const parent = document.querySelector("#terminal")!;
              parent.replaceChildren();
              const term = new (window as any).Terminal({
                cols: 140,
                rows: 8,
                fontFamily: family,
                fontSize,
                lineHeight: 1.25,
              });
              term.open(parent);
              const rows = [
                "-".repeat(139) + "R",
                Array.from(
                  { length: 140 },
                  (_, i) => `\x1b[${i % 2 ? 32 : 31}mW`,
                ).join(""),
                Array.from(
                  { length: 140 },
                  (_, i) => `\x1b[${i % 2 ? 1 : 0}mi`,
                ).join(""),
                "文".repeat(70),
                Array.from(
                  { length: 140 },
                  (_, i) => `\x1b[38;2;${i};150;180m${"Wa.-M"[i % 5]}`,
                ).join(""),
              ];
              await new Promise<void>((resolve) =>
                term.write(
                  rows
                    .map((text, i) => `\x1b[${i + 1};1H${text}\x1b[0m`)
                    .join(""),
                  resolve,
                ),
              );
              await new Promise(requestAnimationFrame);
              const screen = parent
                .querySelector(".xterm-screen")!
                .getBoundingClientRect();
              const readings = [...parent.querySelectorAll(".xterm-rows > div")]
                .slice(0, rows.length)
                .map((row) => {
                  const spans = [...row.children];
                  const last = spans.at(-1)!;
                  const range = document.createRange();
                  range.selectNodeContents(last);
                  return {
                    overflow:
                      range.getBoundingClientRect().right - screen.right,
                    startError:
                      spans.length === 140
                        ? Math.max(
                            ...spans.map((span, i) =>
                              Math.abs(
                                span.getBoundingClientRect().left -
                                  screen.left -
                                  (i * screen.width) / 140,
                              ),
                            ),
                          )
                        : 0,
                  };
                });
              term.dispose();
              return readings;
            },
            { family, fontSize },
          );
          expect(
            Math.max(...errors.map((r) => r.overflow)),
            `${family}, ${fontSize}px`,
          ).toBeLessThanOrEqual(0.1);
          expect(
            Math.max(...errors.map((r) => r.startError)),
            `${family}, ${fontSize}px`,
          ).toBeLessThanOrEqual(0.1);
        }
      }
    } finally {
      await context.close();
    }
  });
}
