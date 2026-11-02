import type { Samples } from "./transport-policy";

type Signal = { type: string; id?: string; sdp?: string };
type SignalSender = (frame: object) => boolean;

// An isolated peer can only send probes until the agent explicitly promotes it.
// Its signaling and lifetime remain bound to the terminal's WebSocket lease.
export class AlternativePath {
  readonly id = crypto.randomUUID();
  readonly peer: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  private closed = false;
  private signalWait?: { resolve: (value: Signal) => void; timer: number };
  private probes = new Map<string, (value: number | null) => void>();

  constructor(
    urls: string[],
    private send: SignalSender,
  ) {
    this.peer = new RTCPeerConnection({
      iceServers: urls.length
        ? [{ urls: urls.filter((u) => u.startsWith("stun:")) }]
        : [],
    });
    this.channel = this.peer.createDataChannel("workdeck-path", {
      ordered: true,
    });
    this.channel.binaryType = "arraybuffer";
    this.channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const value = JSON.parse(event.data) as Signal;
        if (value.type === "probe-reply" && value.id)
          this.probes.get(value.id)?.(performance.now());
      } catch {
        /* Invalid messages do not affect the terminal. */
      }
    };
  }

  signal(frame: Signal): boolean {
    if (frame.id !== this.id || !this.signalWait) return false;
    if (
      !["rtc-path-answer", "rtc-path-unavailable", "rtc-path-ready"].includes(
        frame.type,
      )
    )
      return false;
    const waiter = this.signalWait;
    this.signalWait = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
    return true;
  }

  private waitSignal(timeout: number): Promise<Signal> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.signalWait = undefined;
        resolve({ type: "timeout" });
      }, timeout);
      this.signalWait = { resolve, timer };
    });
  }

  async connect(mode: "native" | "tailnet"): Promise<boolean> {
    try {
      await this.peer.setLocalDescription(await this.peer.createOffer());
      await new Promise<void>((resolve) => {
        if (this.peer.iceGatheringState === "complete") return resolve();
        const done = () => {
          clearTimeout(timer);
          this.peer.removeEventListener("icegatheringstatechange", changed);
          resolve();
        };
        const changed = () => {
          if (this.peer.iceGatheringState === "complete") done();
        };
        const timer = window.setTimeout(done, 5000);
        this.peer.addEventListener("icegatheringstatechange", changed);
      });
      if (this.closed || !this.peer.localDescription?.sdp) return false;
      const answer = this.waitSignal(12000);
      if (
        !this.send({
          type: "rtc-path-offer",
          id: this.id,
          route: mode,
          sdp: this.peer.localDescription.sdp,
        })
      )
        return false;
      const frame = await answer;
      if (this.closed || frame.type !== "rtc-path-answer" || !frame.sdp)
        return false;
      await this.peer.setRemoteDescription({ type: "answer", sdp: frame.sdp });
      if (this.channel.readyState === "open") return true;
      return await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => finish(false), 15000);
        const finish = (success: boolean) => {
          clearTimeout(timer);
          this.channel.removeEventListener("open", open);
          this.channel.removeEventListener("close", close);
          resolve(success);
        };
        const open = () => finish(true);
        const close = () => finish(false);
        this.channel.addEventListener("open", open);
        this.channel.addEventListener("close", close);
        if (this.channel.readyState === "open") finish(true);
        else if (this.channel.readyState === "closed") finish(false);
      });
    } catch {
      return false;
    }
  }

  async measure(): Promise<Samples> {
    const samples: Samples = [];
    for (let i = 0; i < 6 && !this.closed; i++) {
      samples.push(
        await new Promise<number | null>((resolve) => {
          if (this.channel.readyState !== "open") return resolve(null);
          const id = crypto.randomUUID(),
            started = performance.now();
          const timer = window.setTimeout(() => {
            this.probes.delete(id);
            resolve(null);
          }, 1500);
          this.probes.set(id, (received) => {
            clearTimeout(timer);
            this.probes.delete(id);
            resolve(received === null ? null : received - started);
          });
          try {
            this.channel.send(
              JSON.stringify({ type: "probe", id, padding: ".".repeat(256) }),
            );
          } catch {
            clearTimeout(timer);
            this.probes.delete(id);
            resolve(null);
          }
        }),
      );
      if (i < 5 && !this.closed)
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return samples;
  }

  async promote(): Promise<boolean> {
    if (this.closed) return false;
    const ready = this.waitSignal(4000);
    if (!this.send({ type: "rtc-path-promote", id: this.id })) return false;
    return (await ready).type === "rtc-path-ready" && !this.closed;
  }

  close(notify = true): void {
    if (this.closed) return;
    this.closed = true;
    if (notify) this.send({ type: "rtc-path-close", id: this.id });
    if (this.signalWait) {
      clearTimeout(this.signalWait.timer);
      this.signalWait.resolve({ type: "closed" });
      this.signalWait = undefined;
    }
    for (const resolve of this.probes.values()) resolve(null);
    this.probes.clear();
    this.channel.close();
    this.peer.close();
  }
}
