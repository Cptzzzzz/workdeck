import type { Route } from "../../transport-policy";

// The measured terminal route, not a file probe, is the signal. Short spikes
// and a single timeout do not change pacing; a stale route never throttles.
export class TerminalPressure {
  private route?: Route;
  private baseline?: number;
  private samples = 0;
  private bad = 0;
  private good = 0;
  private level = 0;
  private last = 0;

  sample(route: Route, latency: number | null, now = performance.now()): void {
    if (
      latency !== null &&
      (!Number.isFinite(latency) || latency < 0 || latency > 30000)
    )
      return;
    if (this.route !== route || (this.samples > 0 && now - this.last > 25000)) {
      this.reset();
      this.route = route;
    }
    if (this.samples > 0 && now - this.last < 2000) return;
    this.last = now;
    if (latency === null) {
      if (this.samples >= 3) this.degraded();
      return;
    }
    if (this.baseline === undefined) {
      this.baseline = Math.max(1, latency);
      this.samples = 1;
      return;
    }
    if (this.samples < 3) {
      this.baseline = Math.min(this.baseline, Math.max(1, latency));
      this.samples++;
      return;
    }
    this.samples++;
    const threshold = Math.max(200, this.baseline * 2, this.baseline + 80);
    if (this.samples >= 3 && latency > threshold) {
      this.degraded();
    } else if (latency <= threshold) {
      this.bad = 0;
      this.good++;
      if (this.level > 0 && this.good >= 3) {
        this.level--;
        this.good = 0;
      }
      // Adapt slowly to long-term normal network changes, never to a spike.
      this.baseline = Math.max(1, this.baseline * 0.95 + latency * 0.05);
    }
  }

  delay(now = performance.now()): number {
    if (this.samples < 3 || now - this.last > 25000 || now < this.last)
      return 0;
    return [0, 40, 80, 160, 250][this.level];
  }

  private degraded(): void {
    this.good = 0;
    if (++this.bad >= 2) {
      this.level = Math.min(this.level + 1, 4);
      this.bad = 0;
    }
  }

  private reset(): void {
    this.baseline = undefined;
    this.samples = 0;
    this.bad = 0;
    this.good = 0;
    this.level = 0;
    this.last = 0;
  }
}

const terminals = new Map<string, TerminalPressure>();
export function registerTerminalPressure(id: string) {
  const pressure = new TerminalPressure();
  terminals.set(id, pressure);
  return {
    sample: (route: Route, latency: number | null, now?: number) =>
      pressure.sample(route, latency, now),
    close: () => {
      if (terminals.get(id) === pressure) terminals.delete(id);
    },
  };
}
export function terminalPressureDelay(id: string, now?: number): number {
  return terminals.get(id)?.delay(now) || 0;
}
