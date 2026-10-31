import { chooseRoute, type Route, type Samples } from "../../transport-policy";
import { readRoutePreference } from "../../transport-preferences";
import { encodeControl, type Envelope } from "./protocol";
import type { Workspace } from "./types";

type Callbacks = {
  workspace: Workspace;
  id: () => string;
  epoch: () => number;
  route: () => Route;
  busy: () => boolean;
  relay: (data: string) => void;
  switchRoute: (target: Route) => Promise<void>;
  receive: (
    route: Route,
    kind: "control" | "data",
    data: string | ArrayBuffer,
  ) => void;
  unavailable: (active: boolean) => void;
  metrics: (relay: number | null, direct: number | null) => void;
};
type Probe = {
  route: Route;
  epoch: number;
  started: number;
  timer: number;
  resolve: (value: number | null) => void;
};
const cooldown = new Map<string, number>();

// This peer is scoped to the authenticated relay lease. It never replays a
// mutation; a failed active peer asks the owner to reconnect the file lease.
export class FileDirect {
  private peer?: RTCPeerConnection;
  private control?: RTCDataChannel;
  private data?: RTCDataChannel;
  private closed = false;
  private checking = false;
  private lastSwitch = 0;
  private timers = new Set<number>();
  private probes = new Map<string, Probe>();
  private readonly key: string;
  constructor(private readonly cb: Callbacks) {
    this.key = JSON.stringify([cb.workspace.id, cb.workspace.root_revision]);
  }
  private later(fn: () => void, ms: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const p of this.probes.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.probes.clear();
    this.control?.close();
    this.data?.close();
    this.peer?.close();
  }
  penalize(): void {
    cooldown.set(this.key, Date.now() + 120000);
  }
  private abandon(): void {
    if (this.closed) return;
    const active = this.cb.route() === "direct";
    this.penalize();
    this.close();
    this.cb.unavailable(active);
  }
  async start(urls: string[]): Promise<void> {
    if (
      this.closed ||
      typeof RTCPeerConnection === "undefined" ||
      new URLSearchParams(location.search).get("transport") === "relay" ||
      Date.now() < (cooldown.get(this.key) || 0)
    )
      return;
    try {
      const stun = urls
        .filter((u) => u.startsWith("stun:") && u.length < 256)
        .slice(0, 4);
      const peer = new RTCPeerConnection({
        iceServers: stun.length ? [{ urls: stun }] : [],
      });
      this.peer = peer;
      const control = peer.createDataChannel("workdeck-file-control", {
          ordered: true,
        }),
        data = peer.createDataChannel("workdeck-file-data", { ordered: true });
      this.control = control;
      this.data = data;
      data.binaryType = "arraybuffer";
      control.onmessage = (e) => this.cb.receive("direct", "control", e.data);
      data.onmessage = (e) => this.cb.receive("direct", "data", e.data);
      for (const ch of [control, data]) {
        ch.onclose = () => this.abandon();
        ch.onerror = () => this.abandon();
        ch.onopen = () => {
          if (control.readyState === "open" && data.readyState === "open")
            void this.compare();
        };
      }
      peer.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(peer.connectionState)) this.abandon();
      };
      this.later(() => {
        if (control.readyState !== "open" || data.readyState !== "open")
          this.abandon();
      }, 18000);
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve) => {
        if (peer.iceGatheringState === "complete") {
          resolve();
          return;
        }
        const done = () => {
          peer.removeEventListener("icegatheringstatechange", changed);
          clearTimeout(timer);
          resolve();
        };
        const changed = () => {
          if (peer.iceGatheringState === "complete") done();
        };
        const timer = setTimeout(done, 5000);
        peer.addEventListener("icegatheringstatechange", changed);
      });
      if (!this.closed && peer.localDescription?.sdp) {
        const id = this.cb.id();
        this.cb.relay(
          this.frame("file.rtc.offer", id, { sdp: peer.localDescription.sdp }),
        );
      }
    } catch {
      this.abandon();
    }
  }
  answer(sdp: unknown): void {
    if (typeof sdp !== "string" || !this.peer || this.closed) return;
    void this.peer
      .setRemoteDescription({ type: "answer", sdp })
      .catch(() => this.abandon());
  }
  unavailable(): void {
    this.abandon();
  }
  private frame(type: string, id: string, payload: unknown): string {
    return encodeControl({
      version: 1,
      type,
      request_id: id,
      workspace_id: this.cb.workspace.id,
      root_revision: this.cb.workspace.root_revision,
      route_epoch: this.cb.epoch(),
      payload,
    });
  }
  send(kind: "control" | "data", payload: string | ArrayBuffer): void {
    const ch = kind === "control" ? this.control : this.data;
    if (
      this.closed ||
      !ch ||
      ch.readyState !== "open" ||
      ch.bufferedAmount +
        (typeof payload === "string"
          ? new TextEncoder().encode(payload).length
          : payload.byteLength) >
        256 * 1024
    )
      throw new Error("文件直连不可用或缓冲区已满");
    if (typeof payload === "string") ch.send(payload);
    else ch.send(payload);
  }
  private probe(route: Route): Promise<number | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.cb.id(),
        epoch = this.cb.epoch(),
        timer = window.setTimeout(() => {
          this.probes.delete(id);
          resolve(null);
        }, 1500);
      this.probes.set(id, {
        route,
        epoch,
        started: performance.now(),
        timer,
        resolve,
      });
      try {
        const payload = this.frame("file.probe", id, {});
        if (route === "relay") this.cb.relay(payload);
        else this.send("control", payload);
      } catch {
        clearTimeout(timer);
        this.probes.delete(id);
        resolve(null);
      }
    });
  }
  reply(route: Route, message: Envelope): void {
    const p = this.probes.get(message.request_id);
    if (!p || p.route !== route || p.epoch !== message.route_epoch) return;
    this.probes.delete(message.request_id);
    clearTimeout(p.timer);
    p.resolve(performance.now() - p.started);
  }
  private async isDirectPair(): Promise<boolean> {
    if (!this.peer) return false;
    const stats = await this.peer.getStats();
    let pair: RTCStats | undefined;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId)
        pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair)
      stats.forEach((s) => {
        if (
          s.type === "candidate-pair" &&
          s.nominated &&
          s.state === "succeeded"
        )
          pair = s;
      });
    const selected = pair as
      | (RTCStats & { localCandidateId?: string; remoteCandidateId?: string })
      | undefined;
    if (!selected?.localCandidateId || !selected.remoteCandidateId)
      return false;
    return [selected.localCandidateId, selected.remoteCandidateId].every((id) =>
      ["host", "srflx", "prflx"].includes(stats.get(id)?.candidateType),
    );
  }
  private async compare(): Promise<void> {
    if (
      this.checking ||
      this.closed ||
      this.control?.readyState !== "open" ||
      this.data?.readyState !== "open"
    )
      return;
    this.checking = true;
    try {
      if (document.hidden) return;
      if (!(await this.isDirectPair())) {
        this.abandon();
        return;
      }
      const relay: Samples = [],
        direct: Samples = [];
      for (let i = 0; i < 6; i++) {
        if (this.cb.busy()) return;
        const [r, d] = await Promise.all([
          this.probe("relay"),
          this.probe("direct"),
        ]);
        if (this.closed) return;
        relay.push(r);
        direct.push(d);
        this.cb.metrics(r, d);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const target =
        new URLSearchParams(location.search).get("file_transport") ===
          "direct" && direct.every((v) => v !== null)
          ? "direct"
          : chooseRoute(relay, direct, this.cb.route(), readRoutePreference());
      if (target !== this.cb.route() && Date.now() - this.lastSwitch > 30000) {
        await this.cb.switchRoute(target);
        this.lastSwitch = Date.now();
      }
    } catch {
      if (this.cb.route() === "direct") this.abandon();
    } finally {
      this.checking = false;
      if (!this.closed) this.later(() => void this.compare(), 15000);
    }
  }
}
