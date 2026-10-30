import { test, expect } from "@playwright/test";
import { chooseRoute, summarize } from "../src/transport-policy";

test("choose by latency and consistency, prefer direct only when competitive", () => {
  expect(
    chooseRoute([70, 72, 68, 75, 71, 70], [10, 12, 11, 10, 13, 11], "relay"),
  ).toBe("direct");
  expect(
    chooseRoute([10, 11, 12, 11, 10, 12], [55, 54, 58, 52, 57, 55], "relay"),
  ).toBe("relay");
  expect(
    chooseRoute([10, 11, 10, 11, 10, 11], [11, 12, 11, 12, 11, 12], "relay"),
  ).toBe("direct");
  expect(
    chooseRoute([30, 30, 31, 29, 30, 30], [8, 9, 8, 9, 8, 200], "relay"),
  ).toBe("relay");
  expect(
    chooseRoute([30, 30, 31, 29, 30, 30], [8, 9, 8, 9, 8, null], "relay"),
  ).toBe("relay");
  expect(
    chooseRoute([10, 11, 10, 11, 10, 11], [15, 15, 16, 15, 16, 15], "direct"),
  ).toBe("direct");
  expect(
    chooseRoute([10, 11, 10, 11, 10, 11], [60, 60, 61, 60, 61, 60], "direct"),
  ).toBe("relay");
  expect(summarize([null, 1, 2])).toBeNull();
});
