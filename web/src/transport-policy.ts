export type Route = "relay" | "direct";
export type Samples = Array<number | null>;
export function summarize(samples: Samples) {
  const values = samples
    .filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (values.length < 5) return null;
  return {
    median: values[Math.floor(values.length / 2)],
    tail: values[Math.ceil(values.length * 0.9) - 1],
    failures: samples.length - values.length,
  };
}

// Interactive latency, jitter and failed probes take priority. Near-equivalent
// paths prefer direct delivery to avoid spending the Hub's relay bandwidth.
// A wider threshold when already direct avoids oscillating on small variations.
export function chooseRoute(
  relay: Samples,
  direct: Samples,
  current: Route,
): Route {
  const r = summarize(relay),
    d = summarize(direct);
  if (!d || d.failures > 0) return "relay";
  if (!r) return "direct";
  if (current === "direct") {
    return d.median > r.median + Math.max(12, r.median * 0.3) ||
      d.tail > r.tail + Math.max(20, r.tail * 0.5)
      ? "relay"
      : "direct";
  }
  const faster = d.median <= r.median * 0.85 && r.median - d.median >= 5;
  const comparable = d.median <= r.median + 3 && d.tail <= r.tail + 5;
  return (faster && d.tail <= r.tail + 10) || comparable ? "direct" : "relay";
}
