export type Route = "relay" | "direct";
export type RoutePreference = "balanced" | "prefer-direct";
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

// A replacement must offer a material median improvement without a much worse
// latency tail. A few sub-millisecond samples are not a reason to hand over.
export function preferAlternative(
  current: Samples,
  alternative: Samples,
): boolean {
  const a = summarize(alternative),
    c = summarize(current);
  if (!a || a.failures) return false;
  if (!c || c.failures) return true;
  return (
    c.median - a.median >= Math.max(5, c.median * 0.15) &&
    a.tail <= c.tail + Math.max(10, c.tail * 0.3)
  );
}

// Interactive latency, jitter and failed probes take priority. Near-equivalent
// paths prefer direct delivery to avoid spending the Hub's relay bandwidth.
// A wider threshold when already direct avoids oscillating on small variations.
export function chooseRoute(
  relay: Samples,
  direct: Samples,
  current: Route,
  preference: RoutePreference = "balanced",
): Route {
  const r = summarize(relay),
    d = summarize(direct);
  if (!d || d.failures > 0) return "relay";
  if (!r) return "direct";
  if (preference === "prefer-direct") {
    // Give direct connections room to be slower than a cheap relay, while
    // refusing long or erratic paths. Wider retention limits avoid flapping.
    const retaining = current === "direct";
    const maxMedian = retaining ? 350 : 250;
    const maxTail = retaining ? 500 : 400;
    const medianMargin = retaining ? 120 : 80;
    const tailMargin = retaining ? 180 : 120;
    return d.median <= maxMedian &&
      d.tail <= maxTail &&
      d.median <= r.median + medianMargin &&
      d.tail <= r.tail + tailMargin
      ? "direct"
      : "relay";
  }
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
