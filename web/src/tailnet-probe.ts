import { api } from "./services/api";

type Status = "disabled" | "checking" | "available" | "unavailable";
let status: Status = "disabled";
const listeners = new Set<() => void>();
export const readTailnetProbe = () => status;
export function subscribeTailnetProbe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(value: Status) {
  if (status === value) return;
  status = value;
  listeners.forEach((listener) => listener());
}

type Challenge = { enabled: boolean; challenge?: string; probe_url?: string };

// Optional and scoped to the logged-in page. It does not infer a node path.
export function startTailnetProbe(): () => void {
  let stopped = false;
  let current: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let validUntil = 0;
  const visible = () => {
    if (!document.hidden && status === "available" && Date.now() >= validUntil)
      publish("unavailable");
  };
  document.addEventListener("visibilitychange", visible);
  async function probe() {
    if (stopped) return;
    current = new AbortController();
    const signal = current.signal;
    try {
      const challenge = await api<Challenge>("/tailnet/probe", {
        method: "POST",
        body: "{}",
        signal,
      });
      if (stopped) return;
      if (!challenge.enabled) {
        publish("disabled");
        return;
      }
      if (
        !/^[0-9a-f]{48}$/.test(challenge.challenge || "") ||
        !challenge.probe_url
      )
        throw new Error("invalid challenge");
      const endpoint = new URL(challenge.probe_url);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/probe" ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("invalid endpoint");
      publish("checking");
      const timeout = window.setTimeout(() => current?.abort(), 8000);
      let response: Response;
      try {
        response = await fetch(endpoint.href, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challenge: challenge.challenge }),
          signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error("probe unavailable");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object")
        throw new Error("invalid proof");
      const { device, proof } = result as Record<string, unknown>;
      if (
        typeof device !== "string" ||
        !/^[0-9a-f]{64}$/.test(device) ||
        typeof proof !== "string" ||
        !/^[0-9a-f]{64}$/.test(proof)
      )
        throw new Error("invalid proof");
      const completed = await api<{
        available: boolean;
        valid_for_seconds: number;
      }>("/tailnet/probe/complete", {
        method: "POST",
        body: JSON.stringify({ challenge: challenge.challenge, device, proof }),
        signal,
      });
      if (completed.available !== true || completed.valid_for_seconds !== 120)
        throw new Error("probe not confirmed");
      if (!stopped) {
        validUntil = Date.now() + 120000;
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => {
          if (!stopped && status === "available") publish("unavailable");
        }, 120000);
        publish("available");
      }
    } catch {
      if (!stopped) publish("unavailable");
    } finally {
      if (!stopped && status !== "disabled") timer = setTimeout(probe, 90000);
    }
  }
  void probe();
  return () => {
    stopped = true;
    current?.abort();
    if (timer) clearTimeout(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
    document.removeEventListener("visibilitychange", visible);
    publish("disabled");
  };
}
