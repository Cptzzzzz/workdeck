import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TerminalFontControl } from "../../src/terminal-font-control";
import "../../src/style.css";
function Harness() {
  const [size, setSize] = useState(13);
  return (
    <main
      id="fullscreen-root"
      style={{ padding: 40, minHeight: "100vh", background: "#18231c" }}
    >
      <button
        onClick={() =>
          document.getElementById("fullscreen-root")?.requestFullscreen()
        }
      >
        全屏验收
      </button>
      <output aria-label="当前字号">{size}</output>
      <div
        style={{
          position: "relative",
          width: 270,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <TerminalFontControl
          size={size}
          onChange={setSize}
          onClose={() => {}}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
