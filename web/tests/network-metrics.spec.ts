import { test, expect } from "@playwright/test";
import {
  describeSamples,
  formatBytes,
  formatLatency,
  initialTransportStatus,
  latencyBenefit,
} from "../src/network-metrics";

test("network metrics distinguish missing probes, timeouts and measured zero traffic", () => {
  const initial = initialTransportStatus();
  expect(describeSamples([], 100000)).toMatchObject({
    state: "pending",
    latency: undefined,
    samples: 0,
  });
  expect(initial.relay.latency).toBeUndefined();
  expect(formatLatency(initial.relay.latency)).toBe("—");
  expect(formatBytes(initial.traffic.relay.received)).toBe("0 B");
  expect(formatBytes(2048)).toBe("2.0 KiB");
  expect(formatBytes(1024 ** 2)).toBe("1.0 MiB");
  expect(formatLatency(0.8)).toBe("0.8 ms");
  const path = describeSamples([10, 14, null, 30], 100000);
  expect(path).toMatchObject({
    latency: 14,
    jitter: 4,
    samples: 4,
    failures: 1,
    state: "available",
  });
  expect(describeSamples([10, null], 100001)).toMatchObject({
    state: "timeout",
    failures: 1,
    jitter: undefined,
  });
  const direct = describeSamples([5, 5, 5], 100000),
    relay = describeSamples([25, 25, 25], 100000);
  expect(latencyBenefit(relay, direct, 100001)).toBe(
    "WebRTC 比 WebSocket 低 20 ms（80%）",
  );
  expect(latencyBenefit(relay, direct, 130001)).toBe("等待两条链路的有效测量");
  expect(
    latencyBenefit(relay, { ...direct, state: "unavailable" }, 100001),
  ).toBe("等待两条链路的有效测量");
});
