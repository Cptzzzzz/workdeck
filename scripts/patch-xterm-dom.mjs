// xterm 5.5's DOM WidthCache rounds a 32-glyph sample to integer CSS pixels
// through offsetWidth. Dividing the rounded sample produces a per-cell error;
// the resulting letter-spacing accumulates and clips the final column.
// Preserve fractional CSS pixels instead, for all four font variants.
// Independently position styled runs at their logical cell boundary as well:
// inline-block layout rounds each run separately, accumulating another error
// on ANSI-colored/bold TUI rows even after the width measurement is fixed.
// Keep the pinned dependency and fail closed when its implementation changes.
// Also preserve a selection when a TUI repeats its active mouse mode.
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
  // Repeated TUI mouse-mode declarations must not erase an existing selection.
  [
    "lib/xterm.js",
    "disable(){this.clearSelection(),this._enabled=!1}",
    "disable(){this._enabled=!1}",
  ],
  [
    "src/browser/services/SelectionService.ts",
    "  public disable(): void {\n    this.clearSelection();\n    this._enabled = false;\n  }",
    "  public disable(): void {\n    this._enabled = false;\n  }",
  ],
  ["lib/xterm.js", "i.offsetWidth/32", "i.getBoundingClientRect().width/32"],
  [
    "src/browser/renderer/dom/WidthCache.ts",
    "return el.offsetWidth / WidthCacheSettings.REPEAT;",
    "return el.getBoundingClientRect().width / WidthCacheSettings.REPEAT;",
  ],
  [
    "lib/xterm.js",
    "g.push(C),M=P",
    'C.style.position="absolute",C.style.left=`${M*l}px`,g.push(C),M=P',
  ],
  [
    "src/browser/renderer/dom/DomRendererRowFactory.ts",
    "      elements.push(charElement);",
    '      charElement.style.position = "absolute";\n      charElement.style.left = `${x * cellWidth}px`;\n      elements.push(charElement);',
  ],
  [
    "lib/xterm.js",
    'const e=this._document.createElement("div");this._rowContainer.appendChild(e),this._rowElements.push(e)',
    'const e=this._document.createElement("div");e.style.position="relative",this._rowContainer.appendChild(e),this._rowElements.push(e)',
  ],
  [
    "src/browser/renderer/dom/DomRenderer.ts",
    "      this._rowContainer.appendChild(row);",
    '      row.style.position = "relative";\n      this._rowContainer.appendChild(row);',
  ],
];
const changes = [];
for (const [path, before, after] of patches) {
  const file = new URL(path, root),
    source = readFileSync(file, "utf8");
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2)
    throw new Error(
      `Unexpected xterm width measurement implementation in ${path}`,
    );
  // Validate every replacement before changing either the source or bundle.
  const previous = changes.find((change) => change.file.href === file.href);
  if (previous) previous.source = previous.source.replace(before, after);
  else changes.push({ file, source: source.replace(before, after) });
}
for (const { file, source } of changes) writeFileSync(file, source);
