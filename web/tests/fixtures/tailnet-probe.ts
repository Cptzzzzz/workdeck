import { setCSRF } from "../../src/services/api";
import {
  readTailnetProbe,
  startTailnetProbe,
  subscribeTailnetProbe,
  tailnetTraceEnabled,
} from "../../src/tailnet-probe";
(window as any).__tailnetTraceEnabled = tailnetTraceEnabled;
setCSRF("fixture-csrf");
const render = () => {
  document.querySelector("#status")!.textContent = readTailnetProbe();
};
subscribeTailnetProbe(render);
render();
startTailnetProbe();
