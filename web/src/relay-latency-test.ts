import { HttpTerminalSocket } from "./http-terminal-socket";
import type { RelayProtocol } from "./network-metrics";

export async function measureRelayLatency(
  url: string,
  protocol: RelayProtocol,
  signal: AbortSignal,
): Promise<Array<number | null>> {
  const endpoint = new URL(url);
  endpoint.searchParams.delete("takeover");
  endpoint.searchParams.set("deferred", "1");
  endpoint.searchParams.set("probe_only", "1");
  const socket =
    protocol === "http-stream"
      ? new HttpTerminalSocket(endpoint)
      : new WebSocket(endpoint);
  let waiting: ((value: number | null) => void) | undefined;
  let expected = "";
  let started = 0;
  let readyResolve: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => (readyResolve = resolve));
  const abort = () => {
    readyResolve(false);
    waiting?.(null);
    socket.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 8000);
  socket.onopen = () => {
    if (signal.aborted) return abort();
    socket.send(JSON.stringify({ type: "start" }));
  };
  socket.onmessage = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    try {
      const frame = JSON.parse(event.data);
      if (frame.type === "ready") readyResolve(true);
      else if (frame.type === "probe-reply" && frame.id === expected)
        waiting?.(performance.now() - started);
      else if (frame.type === "error") abort();
    } catch {
      /* Invalid replies never affect the active terminal. */
    }
  };
  socket.onclose = () => {
    readyResolve(false);
    waiting?.(null);
  };
  const samples: Array<number | null> = [];
  try {
    if (signal.aborted || !(await ready)) return samples;
    clearTimeout(deadline);
    for (let i = 0; i < 6 && !signal.aborted; i++) {
      samples.push(
        await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => finish(null), 1500);
          const finish = (value: number | null) => {
            clearTimeout(timer);
            waiting = undefined;
            resolve(value);
          };
          waiting = finish;
          expected = crypto.randomUUID();
          started = performance.now();
          if (socket.readyState !== WebSocket.OPEN) return finish(null);
          try {
            socket.send(JSON.stringify({ type: "probe", id: expected }));
          } catch {
            finish(null);
          }
        }),
      );
    }
    return samples;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    waiting?.(null);
    socket.close();
  }
}
