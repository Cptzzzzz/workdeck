import {
  chooseRoute,
  summarize,
  type Route,
  type Samples,
} from "./transport-policy";

export type TransportStatus = {
  route: Route;
  latency?: number;
  detail: string;
};
type Frame = {
  type: string;
  id?: string;
  route?: Route;
  sdp?: string;
  ice_servers?: string[];
};
type Payload = string | Uint8Array;
type Probe = {
  route: Route;
  start: number;
  finish: (rtt: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
};
const cooldown = new Map<string, number>();

// The WebSocket remains the authorization lease even when terminal bytes go
// directly to the Agent. Losing it closes the peer, preserving Hub revocation.
export class TerminalTransport {
  readonly ws: WebSocket;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private active: Route = "relay";
  private closed = false;
  private attempted = false;
  private checking = false;
  private probes = new Map<string, Probe>();
  private pending: {
    id: string;
    target: Route;
    fenced: boolean;
    queue: Payload[];
    bytes: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private health: ReturnType<typeof setInterval> | null = null;
  private comparison: ReturnType<typeof setTimeout> | null = null;
  private lastSwitch = 0;
  private misses = 0;
  private key: string;
  private onVisible = () => {
    if (!document.hidden) void this.compare();
  };

  constructor(
    url: string,
    private report: (state: TransportStatus) => void,
    node: string,
  ) {
    this.key = node;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.report({
      route: "relay",
      detail: "使用服务器中转，后台自动比较可用链路",
    });
    this.ws.onmessage = (event) => this.receive("relay", event.data);
    this.ws.onclose = () => {
      this.dispose();
      this.onclose?.();
    };
    this.ws.onerror = () => this.onerror?.();
    document.addEventListener("visibilitychange", this.onVisible);
  }

  get readyState() {
    return this.closed ? WebSocket.CLOSED : this.ws.readyState;
  }

  send(payload: Payload) {
    if (this.readyState !== WebSocket.OPEN) return;
    // ACKs are valid on either path, including during the output fence.
    if (
      this.pending &&
      !(typeof payload === "string" && JSON.parse(payload).type === "ack")
    ) {
      const bytes =
        typeof payload === "string"
          ? new TextEncoder().encode(payload).byteLength
          : payload.byteLength;
      if (this.pending.bytes + bytes > 256 * 1024) {
        this.fallback();
        return;
      }
      this.pending.queue.push(
        typeof payload === "string" ? payload : payload.slice(),
      );
      this.pending.bytes += bytes;
      return;
    }
    if (!this.rawSend(this.active, payload)) this.fallback();
  }

  close() {
    this.dispose();
    this.ws.close();
  }

  private rawSend(route: Route, payload: Payload): boolean {
    if (this.closed) return false;
    try {
      if (route === "relay" && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(payload);
        return true;
      }
      if (
        route === "direct" &&
        this.channel?.readyState === "open" &&
        this.channel.bufferedAmount < 1 << 20
      ) {
        if (typeof payload === "string") this.channel.send(payload);
        else this.channel.send(payload as Uint8Array<ArrayBuffer>);
        return true;
      }
    } catch {}
    return false;
  }

  private later(callback: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) callback();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private dispose() {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.health) clearInterval(this.health);
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null; // Unconfirmed input is never replayed after reconnect.
    for (const probe of this.probes.values()) {
      clearTimeout(probe.timer);
      probe.finish(null);
    }
    this.probes.clear();
    this.channel?.close();
    this.peer?.close();
  }

  private fallback() {
    if (this.closed) return;
    cooldown.set(this.key, Date.now() + 120000);
    this.report({ route: "relay", detail: "直连不稳定，正在恢复服务器中转" });
    // Reattach and redraw the same tmux session. Never resend uncertain input.
    this.dispose();
    this.ws.close();
  }

  private abandon() {
    if (this.closed) return;
    if (this.active === "direct" || this.pending) {
      this.fallback();
      return;
    }
    const peer = this.peer;
    this.peer = null;
    this.channel = null;
    if (this.health) clearInterval(this.health);
    this.health = null;
    peer?.close();
    cooldown.set(this.key, Date.now() + 120000);
    this.report({ route: "relay", detail: "直连暂不可用，继续使用服务器中转" });
  }

  private receive(route: Route, data: string | ArrayBuffer) {
    if (this.closed) return;
    if (typeof data !== "string") {
      if (route === this.active && !this.pending?.fenced)
        this.onmessage?.({ data });
      return;
    }
    let frame: Frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === "probe-reply" && frame.id) {
      const probe = this.probes.get(frame.id);
      if (probe && probe.route === route) {
        this.probes.delete(frame.id);
        clearTimeout(probe.timer);
        probe.finish(performance.now() - probe.start);
      }
      return;
    }
    if (frame.type === "rtc-config" && route === "relay") {
      void this.startPeer(frame.ice_servers || []);
      return;
    }
    if (frame.type === "rtc-answer" && route === "relay") {
      const peer = this.peer;
      if (peer && frame.sdp)
        void peer
          .setRemoteDescription({ type: "answer", sdp: frame.sdp })
          .catch(() => this.abandon());
      return;
    }
    if (frame.type === "rtc-unavailable") {
      this.abandon();
      return;
    }
    if (frame.type === "route-ready") {
      const pending = this.pending;
      if (
        pending &&
        frame.id === pending.id &&
        frame.route === pending.target &&
        route === this.active
      ) {
        pending.fenced = true;
        // All preceding output has arrived on the old ordered channel. The
        // Agent is now paused until commit reaches the new ordered channel.
        if (
          !this.rawSend(
            pending.target,
            JSON.stringify({ type: "route-commit", id: pending.id }),
          )
        )
          this.fallback();
      }
      return;
    }
    if (frame.type === "route-active") {
      const pending = this.pending;
      if (pending && frame.id === pending.id && route === pending.target) {
        clearTimeout(pending.timer);
        this.active = pending.target;
        this.lastSwitch = Date.now();
        this.pending = null;
        this.misses = 0;
        this.report({
          route: this.active,
          detail:
            this.active === "direct"
              ? "已比较延迟与稳定性，使用直连"
              : "中转链路表现更好，使用服务器中转",
        });
        for (const payload of pending.queue) {
          if (!this.rawSend(this.active, payload)) {
            this.fallback();
            break;
          }
        }
      }
      return;
    }
    if (route === "relay") this.onmessage?.({ data });
  }

  private async startPeer(urls: string[]) {
    if (
      this.attempted ||
      this.closed ||
      typeof RTCPeerConnection === "undefined" ||
      Date.now() < (cooldown.get(this.key) || 0) ||
      new URLSearchParams(location.search).get("transport") === "relay"
    )
      return;
    this.attempted = true;
    try {
      const peer = new RTCPeerConnection({
        iceServers: urls.length
          ? [{ urls: urls.filter((url) => url.startsWith("stun:")) }]
          : [],
      });
      this.peer = peer;
      const channel = peer.createDataChannel("workdeck", { ordered: true });
      this.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (event) => this.receive("direct", event.data);
      channel.onclose = () => {
        if (this.peer === peer) this.abandon();
      };
      channel.onerror = () => {
        if (this.peer === peer) this.abandon();
      };
      peer.onconnectionstatechange = () => {
        if (
          this.peer === peer &&
          ["failed", "closed"].includes(peer.connectionState)
        )
          this.abandon();
      };
      const deadline = this.later(() => {
        if (channel.readyState !== "open") this.abandon();
      }, 18000);
      channel.onopen = () => {
        clearTimeout(deadline);
        if (this.closed || this.peer !== peer) return;
        void this.compare();
        this.health = setInterval(() => void this.checkHealth(), 5000);
      };
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
      if (!this.closed && this.peer === peer && peer.localDescription)
        this.rawSend(
          "relay",
          JSON.stringify({ type: "rtc-offer", sdp: peer.localDescription.sdp }),
        );
    } catch {
      this.abandon();
    }
  }

  private probe(route: Route): Promise<number | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.probes.delete(id);
        resolve(null);
      }, 1500);
      this.probes.set(id, {
        route,
        start: performance.now(),
        finish: resolve,
        timer,
      });
      if (
        !this.rawSend(
          route,
          JSON.stringify({ type: "probe", id, padding: ".".repeat(256) }),
        )
      ) {
        clearTimeout(timer);
        this.probes.delete(id);
        resolve(null);
      }
    });
  }

  private async isDirectPair() {
    if (!this.peer) return false;
    const stats = await this.peer.getStats();
    let pair: RTCStats | undefined;
    stats.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId)
        pair = stats.get(stat.selectedCandidatePairId);
    });
    if (!pair)
      stats.forEach((stat) => {
        if (
          stat.type === "candidate-pair" &&
          stat.nominated &&
          stat.state === "succeeded"
        )
          pair = stat;
      });
    const selected = pair as
      | (RTCStats & { localCandidateId?: string; remoteCandidateId?: string })
      | undefined;
    if (!selected?.localCandidateId || !selected.remoteCandidateId)
      return false;
    const types = ["host", "srflx", "prflx"];
    return (
      types.includes(stats.get(selected.localCandidateId)?.candidateType) &&
      types.includes(stats.get(selected.remoteCandidateId)?.candidateType)
    );
  }

  private async compare() {
    if (
      this.checking ||
      this.closed ||
      document.hidden ||
      this.channel?.readyState !== "open"
    )
      return;
    if (this.comparison) {
      clearTimeout(this.comparison);
      this.timers.delete(this.comparison);
      this.comparison = null;
    }
    this.checking = true;
    try {
      if (!(await this.isDirectPair())) {
        this.abandon();
        return;
      }
      const relay: Samples = [],
        direct: Samples = [];
      for (let i = 0; i < 6; i++) {
        const [r, d] = await Promise.all([
          this.probe("relay"),
          this.probe("direct"),
        ]);
        if (this.closed) return;
        relay.push(r);
        direct.push(d);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (document.hidden || this.pending) return;
      const target = chooseRoute(relay, direct, this.active);
      const summary = summarize(this.active === "direct" ? direct : relay);
      const rs = summarize(relay),
        ds = summarize(direct);
      const detail = `自动比较：中转 ${rs ? Math.round(rs.median) + " ms" : "不稳定"}，直连 ${ds ? Math.round(ds.median) + " ms" : "不稳定"}；综合延迟、抖动与探测成功率选择`;
      this.report({ route: this.active, latency: summary?.median, detail });
      if (target !== this.active && Date.now() - this.lastSwitch > 30000) {
        const id = crypto.randomUUID();
        this.pending = {
          id,
          target,
          fenced: false,
          queue: [],
          bytes: 0,
          timer: setTimeout(() => this.fallback(), 4500),
        };
        if (
          !this.rawSend(
            this.active,
            JSON.stringify({ type: "route-request", id, route: target }),
          )
        )
          this.fallback();
      }
    } catch {
      if (this.active === "direct") this.fallback();
    } finally {
      this.checking = false;
      if (!this.closed && this.peer)
        this.comparison = this.later(() => void this.compare(), 60000);
    }
  }

  private async checkHealth() {
    if (
      this.closed ||
      document.hidden ||
      this.pending ||
      this.checking ||
      this.active !== "direct"
    )
      return;
    const rtt = await this.probe("direct");
    if (this.closed || document.hidden || this.pending) return;
    if (rtt === null) {
      if (++this.misses >= 2) this.fallback();
    } else {
      this.misses = 0;
      this.report({
        route: "direct",
        latency: rtt,
        detail: "自动选择直连，持续检测链路状态",
      });
    }
  }
}
