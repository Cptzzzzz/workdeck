import { api, getCSRF } from "./services/api";

// A browser relay using an existing HTTP/2 or HTTP/3 session where available.
// It deliberately keeps the WebSocket-shaped terminal transport boundary.
export class HttpTerminalSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private controller = new AbortController();
  private id = "";
  private queue: { kind: number; data: string; size: number }[] = [];
  private flushing = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private watchIdle() {
    if (this.readyState !== 1) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (document.hidden) {
        this.watchIdle();
        return;
      }
      this.finish(1006);
    }, 45000);
  }
  constructor(url: URL) {
    const endpoint = new URL(url);
    endpoint.protocol = location.protocol;
    endpoint.pathname = endpoint.pathname.replace(/\/ws$/, "/stream");
    void this.read(endpoint);
  }
  private async read(url: URL) {
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { "X-Workdeck-CSRF": getCSRF() },
        signal: this.controller.signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body)
        throw new Error("HTTP terminal unavailable");
      this.id = response.headers.get("X-Workdeck-Stream") || "";
      if (!/^[0-9a-f]{48}$/.test(this.id))
        throw new Error("Invalid terminal stream");
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.watchIdle();
      this.onopen?.(new Event("open"));
      if (this.readyState === 3) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (this.readyState !== 3) {
        const next = await reader.read();
        if (this.readyState === 3) return;
        if (next.done) throw new Error("Terminal stream ended");
        this.watchIdle();
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024)
          throw new Error("Terminal stream too large");
        let end: number;
        while (this.readyState !== 3 && (end = pending.indexOf("\n\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (!line.startsWith("data: ")) continue;
          const packet = JSON.parse(line.slice(6));
          if (packet.kind === 0) continue;
          if (packet.kind !== 1 && packet.kind !== 2)
            throw new Error("Invalid terminal packet");
          const decoded = atob(packet.data || "");
          const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
          this.onmessage?.({
            data:
              packet.kind === 1
                ? new TextDecoder().decode(bytes)
                : bytes.buffer,
          });
        }
      }
    } catch {
      if (this.readyState !== 3) {
        this.onerror?.(new Event("error"));
        this.finish(1006);
      }
    }
  }
  send(payload: string | Uint8Array) {
    if (this.readyState !== 1) return;
    const bytes =
      typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    let encoded = "";
    for (let i = 0; i < bytes.length; i += 8192)
      encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
    this.queue.push({
      kind: typeof payload === "string" ? 1 : 2,
      data: btoa(encoded),
      size: bytes.length,
    });
    if (
      this.queue.length > 512 ||
      this.queue.reduce((n, p) => n + p.size, 0) > 2 * 1024 * 1024
    ) {
      this.finish(1006);
      return;
    }
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => void this.flush());
    }
  }
  private async flush() {
    try {
      while (this.queue.length && this.readyState === 1) {
        const packets: { kind: number; data: string }[] = [];
        let size = 0;
        while (this.queue.length && packets.length < 16 && size < 128 * 1024) {
          const next = this.queue.shift()!;
          size += next.size;
          packets.push({ kind: next.kind, data: next.data });
        }
        await api(`/terminal-streams/${this.id}/input`, {
          method: "POST",
          body: JSON.stringify({ packets }),
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(5000),
          ]),
        });
      }
    } catch {
      if (this.readyState !== 3) this.finish(1006);
    } finally {
      this.flushing = false;
    }
  }
  private finish(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.controller.abort();
    this.queue = [];
    this.onclose?.({ code });
  }
  close() {
    this.finish(1000);
  }
}
