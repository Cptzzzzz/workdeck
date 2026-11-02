import { setCSRF } from "../../src/services/api";
import {
  readTailnetProbe,
  startTailnetProbe,
  subscribeTailnetProbe,
} from "../../src/tailnet-probe";
setCSRF("fixture-csrf");
const render = () => {
  document.querySelector("#status")!.textContent = readTailnetProbe();
};
subscribeTailnetProbe(render);
render();
startTailnetProbe();
