import { test, expect } from "@playwright/test";
import {
  TerminalPressure,
  registerTerminalPressure,
  terminalPressureDelay,
} from "../src/services/files/terminal-pressure";

test("file pacing reacts to sustained active-route latency and recovers gradually", () => {
  const p = new TerminalPressure();
  p.sample("relay", 20, 1000);
  p.sample("relay", 22, 6000);
  p.sample("relay", 21, 11000);
  p.sample("relay", 500, 16000);
  expect(p.delay(16000)).toBe(0);
  p.sample("relay", 500, 16080); // a burst of comparison probes is one observation
  expect(p.delay(16080)).toBe(0);
  p.sample("relay", 500, 21000);
  expect(p.delay(21000)).toBe(40);
  p.sample("relay", null, 26000);
  p.sample("relay", null, 31000);
  expect(p.delay(31000)).toBe(80);
  for (const at of [36000, 41000, 46000]) p.sample("relay", 25, at);
  expect(p.delay(46000)).toBe(40);
  for (const at of [51000, 56000, 61000]) p.sample("relay", 25, at);
  expect(p.delay(61000)).toBe(0);
  p.sample("relay", 500, 66000);
  p.sample("relay", 500, 71000);
  expect(p.delay(71000)).toBe(40);
  expect(p.delay(97000)).toBe(0);
  p.sample("direct", 18, 98000);
  p.sample("direct", 19, 103000);
  p.sample("direct", 21, 108000);
  expect(p.delay(108000)).toBe(0);
});

test("reconnecting a terminal cannot let an old attachment erase its new pressure state", () => {
  const id = "isolated-pressure-id";
  const old = registerTerminalPressure(id);
  const current = registerTerminalPressure(id);
  for (const [at, delay] of [
    [1000, 20],
    [6000, 20],
    [11000, 20],
    [16000, 500],
    [21000, 500],
  ])
    current.sample("relay", delay, at);
  old.close();
  expect(terminalPressureDelay(id, 21000)).toBe(40);
  current.close();
  expect(terminalPressureDelay(id, 21000)).toBe(0);
});
