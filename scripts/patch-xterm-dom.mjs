// xterm 5.5's DOM WidthCache rounds a 32-glyph sample to integer CSS pixels
// through offsetWidth. Dividing the rounded sample produces a per-cell error;
// the resulting letter-spacing accumulates and clips the final column.
// Preserve fractional CSS pixels instead, for all four font variants.
// Keep the pinned dependency and fail closed when its implementation changes.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../web/node_modules/@xterm/xterm/", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
if (version !== "5.5.0")
  throw new Error(
    `Review the xterm DOM width patch before upgrading from 5.5.0 (found ${version})`,
  );
const patches = [
  ["lib/xterm.js", "i.offsetWidth/32", "i.getBoundingClientRect().width/32"],
  [
    "src/browser/renderer/dom/WidthCache.ts",
    "return el.offsetWidth / WidthCacheSettings.REPEAT;",
    "return el.getBoundingClientRect().width / WidthCacheSettings.REPEAT;",
  ],
];
for (const [path, before, after] of patches) {
  const file = new URL(path, root),
    source = readFileSync(file, "utf8");
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2)
    throw new Error(
      `Unexpected xterm width measurement implementation in ${path}`,
    );
  writeFileSync(file, source.replace(before, after));
}
