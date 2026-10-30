import {
  chooseRoute,
  summarize,
  type Route,
  type Samples,
} from "./transport-policy";
import {
  describeSamples,
  initialTransportStatus,
  type TransportStatus,
} from "./network-metrics";
export type { TransportStatus } from "./network-metrics";

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
  private meter: ReturnType<typeof setInterval> | null = null;
  private status = initialTransportStatus();
  private samples: Record<Route, Array<number | null>> = {
    relay: [],
    direct: [],
  };
  private bytes: Record<Route, { received: number; sent: number }> = {
    relay: { received: 0, sent: 0 },
    direct: { received: 0, sent: 0 },
  };
  private previousBytes = {
    relay: { received: 0, sent: 0 },
    direct: { received: 0, sent: 0 },
  };
  private meteredAt = performance.now();
  private monitoring = false;
  private healthChecking = false;
  private lastSwitch = 0;
  private misses = 0;
  private key: string;
  private onVisible = () => {
    if (!document.hidden) {
      this.tickTraffic();
      void this.compare();
      void this.checkHealth();
    }
  };

  constructor(
    url: string,
    private report: (state: TransportStatus) => void,
    node: string,
  ) {
    this.key = node;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.publish({
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

  private publish(change: Partial<TransportStatus> = {}) {
    if (this.closed) return;
    this.status = { ...this.status, ...change };
    this.status.latency =
      this.status[this.status.route].state === "available" &&
      Date.now() - (this.status[this.status.route].updatedAt || 0) <= 20000
        ? this.status[this.status.route].latency
        : undefined;
    this.report(this.status);
  }

  private recordProbe(route: Route, rtt: number | null) {
    if (this.closed || document.hidden) return;
    const window = [...this.samples[route], rtt].slice(-12);
    this.samples[route] = window;
    const metric = describeSamples(window, Date.now());
    if (route === "direct" && this.channel?.readyState !== "open") {
      metric.state = this.status.direct.state;
      metric.reason = this.status.direct.reason;
    }
    this.publish({ [route]: metric });
  }

  private tickTraffic() {
    if (this.closed || document.hidden) return;
    const now = performance.now(),
      seconds = (now - this.meteredAt) / 1000;
    if (seconds <= 0) return;
    const traffic = { ...this.status.traffic };
    for (const route of ["relay", "direct"] as const) {
      const current = this.bytes[route],
        previous = this.previousBytes[route];
      traffic[route] = {
        ...current,
        receiveRate: Math.max(
          0,
          (current.received - previous.received) / seconds,
        ),
        sendRate: Math.max(0, (current.sent - previous.sent) / seconds),
      };
      this.previousBytes[route] = { ...current };
    }
    this.meteredAt = now;
    this.publish({ traffic });
  }

  private startMonitoring() {
    if (this.monitoring) return;
    this.monitoring = true;
    this.meter = setInterval(() => this.tickTraffic(), 1000);
    this.health = setInterval(() => void this.checkHealth(), 5000);
    void this.checkHealth();
    this.later(() => {
      if (this.status.direct.state === "pending")
        this.publish({
          direct: {
            ...this.status.direct,
            state: "unavailable",
            reason: "节点暂未提供直连能力",
          },
        });
    }, 6000);
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
        if (typeof payload !== "string")
          this.bytes.relay.sent += payload.byteLength;
        return true;
      }
      if (
        route === "direct" &&
        this.channel?.readyState === "open" &&
        this.channel.bufferedAmount < 1 << 20
      ) {
        if (typeof payload === "string") this.channel.send(payload);
        else this.channel.send(payload as Uint8Array<ArrayBuffer>);
        if (typeof payload !== "string")
          this.bytes.direct.sent += payload.byteLength;
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
    if (this.meter) clearInterval(this.meter);
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
    this.publish({
      detail: "直连不稳定，正在恢复服务器中转",
      direct: {
        ...this.status.direct,
        state: "unavailable",
        reason: "直连中断，正在恢复中转",
      },
    });
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
    peer?.close();
    cooldown.set(this.key, Date.now() + 120000);
    this.publish({
      route: "relay",
      detail: "直连暂不可用，继续使用服务器中转",
      direct: {
        ...this.status.direct,
        state: "unavailable",
        reason: "无法建立稳定的直接连接",
      },
    });
  }

  private receive(route: Route, data: string | ArrayBuffer) {
    if (this.closed) return;
    if (typeof data !== "string") {
      this.bytes[route].received += data.byteLength;
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
        this.publish({
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
    if (route === "relay") {
      if (frame.type === "ready") this.startMonitoring();
      this.onmessage?.({ data });
    }
  }

  private async startPeer(urls: string[]) {
    if (this.attempted || this.closed) return;
    if (typeof RTCPeerConnection === "undefined") {
      this.publish({
        direct: {
          ...this.status.direct,
          state: "unsupported",
          reason: "此浏览器不支持 WebRTC",
        },
      });
      return;
    }
    if (new URLSearchParams(location.search).get("transport") === "relay") {
      this.publish({
        direct: {
          ...this.status.direct,
          state: "disabled",
          reason: "此页面已选择仅使用中转",
        },
      });
      return;
    }
    if (Date.now() < (cooldown.get(this.key) || 0)) {
      this.publish({
        direct: {
          ...this.status.direct,
          state: "cooldown",
          reason: "近期直连异常，本次连接优先使用中转",
        },
      });
      return;
    }
    this.attempted = true;
    this.publish({
      direct: {
        ...this.status.direct,
        state: "measuring",
        reason: "正在建立并测量直接连接",
      },
    });
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
      const finish = (rtt: number | null) => {
        this.recordProbe(route, rtt);
        resolve(rtt);
      };
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.probes.delete(id);
        finish(null);
      }, 1500);
      this.probes.set(id, {
        route,
        start: performance.now(),
        finish,
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
        finish(null);
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
      this.publish({ route: this.active, latency: summary?.median, detail });
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
      this.healthChecking ||
      !this.monitoring
    )
      return;
    this.healthChecking = true;
    try {
      const [, direct] = await Promise.all([
        this.probe("relay"),
        this.channel?.readyState === "open"
          ? this.probe("direct")
          : Promise.resolve(null),
      ]);
      if (this.closed || document.hidden || this.pending) return;
      if (this.active !== "direct") return;
      if (direct === null) {
        if (++this.misses >= 2) this.fallback();
      } else {
        this.misses = 0;
        this.publish({
          route: "direct",
          latency: direct,
          detail: "自动选择直连，持续检测链路状态",
        });
      }
    } finally {
      this.healthChecking = false;
    }
  }
}
