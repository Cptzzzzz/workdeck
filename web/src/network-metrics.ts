import type { Route } from "./transport-policy";

export type PathState =
  | "pending"
  | "measuring"
  | "available"
  | "timeout"
  | "unavailable"
  | "unsupported"
  | "disabled"
  | "cooldown";
export type PathMetrics = {
  state: PathState;
  latency?: number;
  jitter?: number;
  samples: number;
  failures: number;
  updatedAt?: number;
  reason?: string;
};
export type Traffic = {
  received: number;
  sent: number;
  receiveRate: number;
  sendRate: number;
};
export type TransportStatus = {
  route: Route;
  latency?: number;
  detail: string;
  relay: PathMetrics;
  direct: PathMetrics;
  traffic: Record<Route, Traffic>;
};
export function initialTransportStatus(): TransportStatus {
  const path = (): PathMetrics => ({
    state: "pending",
    samples: 0,
    failures: 0,
  });
  const traffic = (): Traffic => ({
    received: 0,
    sent: 0,
    receiveRate: 0,
    sendRate: 0,
  });
  return {
    route: "relay",
    detail: "使用服务器中转，后台自动比较可用链路",
    relay: path(),
    direct: path(),
    traffic: { relay: traffic(), direct: traffic() },
  };
}

// At most twelve application-level probes; these are timeouts, not packet loss.
export function describeSamples(
  samples: Array<number | null>,
  updatedAt: number,
): PathMetrics {
  const values = samples.filter(
    (n): n is number => n !== null && Number.isFinite(n) && n >= 0,
  );
  const sorted = [...values].sort((a, b) => a - b);
  const differences: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1],
      current = samples[i];
    if (previous !== null && current !== null)
      differences.push(Math.abs(current - previous));
  }
  return {
    state: !samples.length
      ? "pending"
      : samples.at(-1) === null
        ? "timeout"
        : "available",
    latency: sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined,
    jitter: differences.length
      ? differences.reduce((sum, n) => sum + n, 0) / differences.length
      : undefined,
    samples: samples.length,
    failures: samples.length - values.length,
    updatedAt,
  };
}

export function formatLatency(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
export function latencyBenefit(
  relay: PathMetrics,
  direct: PathMetrics,
  now = Date.now(),
): string {
  if (
    relay.state !== "available" ||
    direct.state !== "available" ||
    relay.latency === undefined ||
    direct.latency === undefined ||
    !relay.updatedAt ||
    !direct.updatedAt ||
    now - relay.updatedAt > 20000 ||
    now - direct.updatedAt > 20000
  )
    return "等待两条链路的有效测量";
  const difference = relay.latency - direct.latency;
  if (Math.abs(difference) < 3) return "两条链路延迟接近";
  const percent =
    relay.latency > 0
      ? `（${Math.round((Math.abs(difference) / relay.latency) * 100)}%）`
      : "";
  return `WebRTC 比 WebSocket ${difference > 0 ? "低" : "高"} ${formatLatency(Math.abs(difference))}${percent}`;
}
