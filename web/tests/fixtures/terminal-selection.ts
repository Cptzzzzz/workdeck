import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { installTerminalSelection } from "../../src/features/terminal/selection";
const term = new Terminal({
  cols: 80,
  rows: 10,
  macOptionClickForcesSelection: true,
});
term.open(document.getElementById("terminal")!);
installTerminalSelection(term);
const inputs: string[] = [];
term.onData((value) => inputs.push(value));
term.write(
  "\x1b[?1049h\x1b[?1002h\x1b[?1006hCOPY-ME-TERMINAL-TEXT\r\nsecond line",
);
term.focus();
Object.assign(window, { testTerminal: term, testInputs: inputs });
