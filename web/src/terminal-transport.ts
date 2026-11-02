import {
  chooseRoute,
  preferAlternative,
  summarize,
  type Route,
  type Samples,
} from "./transport-policy";
import { readRoutePreference } from "./transport-preferences";
import { loadRtcReport, RtcRecorder, type RtcReport } from "./rtc-diagnostics";
import {
  candidateNetworkScope,
  candidateTypeCode,
  tailscaleCandidateHint,
} from "./tailscale-candidate";
import { tailnetTraceEnabled } from "./tailnet-probe";
import { api } from "./services/api";
import { AlternativePath } from "./alternative-path";
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
  rtc_trickle?: boolean;
  rtc_trace_available?: boolean;
  rtc_paths?: boolean;
  node_diagnostic?: unknown;
  candidate?: RTCIceCandidateInit;
};
type Payload = string | Uint8Array;
type Probe = {
  route: Route;
  start: number;
  finish: (rtt: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
};
const cooldown = new Map<string, number>();
export function clearDirectCooldown(node: string) {
  cooldown.delete(node);
}

// The WebSocket remains the authorization lease even when terminal bytes go
// directly to the Agent. Losing it closes the peer, preserving Hub revocation.
export class TerminalTransport {
  readonly ws: WebSocket;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private peer: RTCPeerConnection | null = null;
  private rtc?: RtcRecorder;
  private rtcSampling?: ReturnType<typeof setInterval>;
  private traceRequested = false;
  private traceLast = 0;
  private traceLastOutcome = "";
  private tailTraceLast = 0;
  private tailTraceLocal: 0 | 1 | 2 | 3 = 0;
  private tailTraceRemote: 0 | 1 | 2 | 3 = 0;
  private tailTraceLocalType: 0 | 1 | 2 | 3 | 4 = 0;
  private tailTraceRemoteType: 0 | 1 | 2 | 3 | 4 = 0;
  private rtcDeadline?: ReturnType<typeof setTimeout>;
  private remoteReady = false;
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private remoteCandidateCount = 0;
  private candidateChain = Promise.resolve();
  private channel: RTCDataChannel | null = null;
  private alternative?: AlternativePath;
  private promotingAlternative = false;
  private nextAlternative = 0;
  private pathsAvailable = false;
  private iceURLs: string[] = [];
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
  private rtcConfig?: { urls: string[]; trickle: boolean; trace: boolean };
  private initialOutputRendered = false;
  private rtcStartScheduled = false;
  private onVisible = () => {
    if (!document.hidden) {
      this.schedulePeer();
      this.tickTraffic();
      void this.compare();
      void this.checkHealth();
    }
  };

  constructor(
    url: string,
    private report: (state: TransportStatus) => void,
    node: string,
    private reportProbe?: (route: Route, rtt: number | null) => void,
    private terminalID = "",
    private isTerminalVisible: () => boolean = () => true,
  ) {
    this.key = node;
    this.status.previousRtcDiagnostic = loadRtcReport(terminalID);
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

  // The relay is already serving the terminal. Defer optional peer setup
  // until the first output has been rendered and this tab is actually visible.
  outputRendered(): void {
    if (this.initialOutputRendered) return;
    this.initialOutputRendered = true;
    this.schedulePeer();
  }
  terminalVisible(): void {
    this.schedulePeer();
  }
  private schedulePeer(): void {
    if (
      this.closed ||
      !this.rtcConfig ||
      !this.initialOutputRendered ||
      this.rtcStartScheduled ||
      document.hidden ||
      !this.isTerminalVisible()
    )
      return;
    this.rtcStartScheduled = true;
    this.later(() => {
      this.rtcStartScheduled = false;
      if (document.hidden || !this.isTerminalVisible() || !this.rtcConfig)
        return;
      const config = this.rtcConfig;
      this.rtcConfig = undefined;
      void this.startPeer(config.urls, config.trickle, config.trace);
    }, 150);
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
    this.emitTailnetDiagnostic();
  }

  private emitTailnetDiagnostic() {
    if (
      this.closed ||
      document.hidden ||
      !this.terminalID ||
      !tailnetTraceEnabled(this.key)
    )
      return;
    const now = performance.now();
    if (now - this.tailTraceLast < 5000) return;
    this.tailTraceLast = now;
    const peerStates = [
      "new",
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "closed",
    ];
    const rtt = (v?: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.min(60000, Math.round(v))
        : -1;
    void api("/tailnet/diagnostic", {
      method: "POST",
      body: JSON.stringify({
        terminal: this.terminalID,
        route: this.active === "direct" ? 1 : 0,
        peer: this.peer
          ? Math.max(0, peerStates.indexOf(this.peer.connectionState) + 1)
          : 0,
        local: this.tailTraceLocal,
        remote: this.tailTraceRemote,
        local_type: this.tailTraceLocalType,
        remote_type: this.tailTraceRemoteType,
        relay_rtt_ms: rtt(this.status.relay.latency),
        direct_rtt_ms: rtt(this.status.direct.latency),
      }),
    }).catch(() => {});
  }

  private recordProbe(route: Route, rtt: number | null) {
    if (this.closed || document.hidden) return;
    if (route === this.active) this.reportProbe?.(route, rtt);
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
    if (this.rtcSampling) clearInterval(this.rtcSampling);
    this.rtc?.cancel();
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
    this.alternative?.close();
  }

  private fallback(reason = "route_interrupted") {
    if (this.closed) return;
    if (this.peer) this.rtc?.states(this.peer, this.channel);
    this.rtc?.finish(reason);
    if (this.rtcSampling) clearInterval(this.rtcSampling);
    cooldown.set(this.key, Date.now() + 120000);
    this.tailTraceLocal = this.tailTraceRemote = 0;
    this.tailTraceLocalType = this.tailTraceRemoteType = 0;
    this.publish({
      detail: "直连不稳定，正在恢复服务器中转",
      tailscaleCandidate: undefined,
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

  private abandon(reason = "channel_closed") {
    if (this.closed) return;
    if (this.active === "direct" || this.pending) {
      this.fallback(reason);
      return;
    }
    const peer = this.peer;
    if (peer) this.rtc?.states(peer, this.channel);
    this.rtc?.finish(reason);
    if (this.rtcSampling) clearInterval(this.rtcSampling);
    this.peer = null;
    this.tailTraceLocal = this.tailTraceRemote = 0;
    this.tailTraceLocalType = this.tailTraceRemoteType = 0;
    this.channel = null;
    peer?.close();
    cooldown.set(this.key, Date.now() + 120000);
    this.publish({
      route: "relay",
      detail: "直连暂不可用，继续使用服务器中转",
      tailscaleCandidate: undefined,
      direct: {
        ...this.status.direct,
        state: "unavailable",
        reason: "无法建立稳定的直接连接",
      },
    });
    this.retryAlternativeIfDue();
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
      this.pathsAvailable = frame.rtc_paths === true;
      this.iceURLs = frame.ice_servers || [];
      this.rtcConfig = {
        urls: this.iceURLs,
        trickle: frame.rtc_trickle === true,
        trace: frame.rtc_trace_available === true,
      };
      this.schedulePeer();
      return;
    }
    if (
      route === "relay" &&
      frame.type.startsWith("rtc-path-") &&
      this.alternative?.signal(frame)
    )
      return;
    if (frame.type === "rtc-answer" && route === "relay") {
      const peer = this.peer;
      if (peer && frame.sdp) {
        this.rtc?.remoteDescription(frame.sdp);
        void peer
          .setRemoteDescription({ type: "answer", sdp: frame.sdp })
          .then(() => {
            if (this.peer !== peer) return;
            this.rtc?.mark("answer_received");
            this.remoteReady = true;
            for (const candidate of this.remoteCandidates)
              this.addRemoteCandidate(peer, candidate);
            this.remoteCandidates = [];
            if (this.rtcDeadline) clearTimeout(this.rtcDeadline);
            this.rtcDeadline = this.later(() => {
              if (this.peer === peer && this.channel?.readyState !== "open")
                this.abandon("timeout");
            }, 20000);
          })
          .catch(() => {
            if (this.peer === peer) this.abandon("answer_error");
          });
      }
      return;
    }
    if (
      frame.type === "rtc-candidate" &&
      route === "relay" &&
      this.peer &&
      frame.candidate &&
      typeof frame.candidate.candidate === "string" &&
      frame.candidate.candidate.length <= 2048 &&
      this.remoteCandidateCount < 128
    ) {
      this.remoteCandidateCount++;
      this.rtc?.remoteCandidate(frame.candidate.candidate);
      if (this.remoteReady) this.addRemoteCandidate(this.peer, frame.candidate);
      else this.remoteCandidates.push(frame.candidate);
      return;
    }
    if (
      frame.type === "rtc-diagnostic" &&
      route === "relay" &&
      frame.node_diagnostic
    ) {
      this.rtc?.nodeDiagnostic(frame.node_diagnostic);
      return;
    }
    if (frame.type === "rtc-unavailable") {
      this.abandon("agent_unavailable");
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
      if (frame.type === "ready") {
        this.startMonitoring();
        // A silent shell must still eventually receive the optional probe.
        this.later(() => this.outputRendered(), 1500);
      }
      this.onmessage?.({ data });
    }
  }

  private addRemoteCandidate(
    peer: RTCPeerConnection,
    candidate: RTCIceCandidateInit,
  ) {
    this.candidateChain = this.candidateChain.then(async () => {
      if (this.peer !== peer || this.closed) return;
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        /* A stale or invalid candidate does not end the relay. */
      }
    });
  }

  private emitTrace(report: RtcReport) {
    if (!this.traceRequested || this.closed) return;
    const now = performance.now();
    if (now - this.traceLast < 1000 && report.outcome === this.traceLastOutcome)
      return;
    this.traceLast = now;
    this.traceLastOutcome = report.outcome;
    const stages = [
      "starting",
      "gathering",
      "offer_sent",
      "answer_received",
      "checking",
      "channel_open",
      "comparing",
      "finished",
    ];
    const outcomes = [
      "in_progress",
      "available",
      "timeout",
      "ice_failed",
      "peer_closed",
      "channel_closed",
      "channel_error",
      "answer_error",
      "agent_unavailable",
      "setup_error",
      "not_direct",
      "route_interrupted",
      "cancelled",
    ];
    const states = [
      "new",
      "checking",
      "connected",
      "completed",
      "disconnected",
      "failed",
      "closed",
    ];
    const connections = [
      "new",
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "closed",
    ];
    const code = (v: string, list: string[]) =>
      Math.max(0, list.indexOf(v) + 1);
    const add = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? Math.min(v, 1000000000)
        : 0;
    const pairs = report.pairs || [];
    const sum = (
      field:
        | "requestsSent"
        | "responsesReceived"
        | "requestsReceived"
        | "responsesSent",
    ) =>
      Math.min(
        1000000000,
        pairs.reduce((n, p) => n + add(p[field]), 0),
      );
    const candidateCount = (counts: Record<string, number>, name: string) =>
      Math.min(
        128,
        Object.entries(counts)
          .filter(([k]) => k.startsWith(name + "/"))
          .reduce((n, [, v]) => n + add(v), 0),
      );
    this.rawSend(
      "relay",
      JSON.stringify({
        type: "rtc-trace",
        browser_trace: {
          elapsedMs: Math.min(120000, Math.round(report.elapsedMs)),
          stage: code(report.stage, stages),
          outcome: code(report.outcome, outcomes),
          ice: code(report.ice, states),
          connection: code(report.connection, connections),
          localHost: candidateCount(report.localCandidates, "host"),
          localSrflx: candidateCount(report.localCandidates, "srflx"),
          remoteHost: candidateCount(report.remoteCandidates, "host"),
          remoteSrflx: candidateCount(report.remoteCandidates, "srflx"),
          pairCount: Math.min(
            128,
            pairs.reduce((n, p) => n + add(p.count), 0),
          ),
          requestsSent: sum("requestsSent"),
          responsesReceived: sum("responsesReceived"),
          requestsReceived: sum("requestsReceived"),
          responsesSent: sum("responsesSent"),
          countersMask: (
            [
              "requestsSent",
              "responsesReceived",
              "requestsReceived",
              "responsesSent",
            ] as const
          ).reduce(
            (mask, field, index) =>
              mask |
              (pairs.length && pairs.every((p) => typeof p[field] === "number")
                ? 1 << index
                : 0),
            0,
          ),
        },
      }),
    );
  }

  private async startPeer(
    urls: string[],
    trickle: boolean,
    traceAvailable: boolean,
  ) {
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
    this.traceRequested =
      traceAvailable && /Windows/i.test(navigator.userAgent);
    this.rtc = new RtcRecorder(
      this.terminalID,
      (current, previous) => {
        this.publish({
          rtcDiagnostic: current,
          previousRtcDiagnostic: previous,
        });
        this.emitTrace(current);
      },
      trickle,
    );
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
      this.rtc?.mark("gathering");
      this.rtc?.states(peer, channel);
      this.rtcSampling = setInterval(() => {
        if (this.peer === peer) void this.rtc?.sample(peer);
      }, 2000);
      let offerSent = false;
      const localCandidates: RTCIceCandidateInit[] = [];
      peer.onicecandidate = (event) => {
        if (this.peer !== peer) return;
        if (event.candidate) this.rtc?.localCandidate(event.candidate);
        if (!trickle) return;
        const candidate = event.candidate
          ? event.candidate.toJSON()
          : { candidate: "" };
        if (!offerSent) {
          if (localCandidates.length < 128) localCandidates.push(candidate);
        } else {
          this.rawSend(
            "relay",
            JSON.stringify({ type: "rtc-candidate", candidate }),
          );
        }
      };
      peer.onicecandidateerror = (event) => {
        if (this.peer === peer) this.rtc?.stunError(event.errorCode);
      };
      peer.onicegatheringstatechange = () => {
        if (this.peer === peer) this.rtc?.states(peer, channel);
      };
      peer.oniceconnectionstatechange = () => {
        if (this.peer === peer) {
          this.rtc?.states(peer, channel);
          if (peer.iceConnectionState === "checking")
            void this.rtc?.sample(peer);
        }
      };
      channel.binaryType = "arraybuffer";
      channel.onmessage = (event) => this.receive("direct", event.data);
      channel.onclose = () => {
        if (this.peer === peer) this.abandon("channel_closed");
      };
      channel.onerror = () => {
        if (this.peer === peer) this.abandon("channel_error");
      };
      peer.onconnectionstatechange = () => {
        if (this.peer === peer) this.rtc?.states(peer, channel);
        if (
          this.peer === peer &&
          ["failed", "closed"].includes(peer.connectionState)
        )
          this.abandon(
            peer.connectionState === "failed" ? "ice_failed" : "peer_closed",
          );
      };
      this.rtcDeadline = this.later(() => {
        if (channel.readyState !== "open") this.abandon("timeout");
      }, 30000);
      channel.onopen = () => {
        if (this.rtcDeadline) clearTimeout(this.rtcDeadline);
        if (this.closed || this.peer !== peer) return;
        this.rtc?.states(peer, channel);
        this.rtc?.mark("channel_open");
        void this.rtc?.sample(peer);
        if (this.rtcSampling) clearInterval(this.rtcSampling);
        void this.compare();
      };
      await peer.setLocalDescription(await peer.createOffer());
      if (!trickle)
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
      if (!this.closed && this.peer === peer && peer.localDescription) {
        this.rawSend(
          "relay",
          JSON.stringify({
            type: "rtc-offer",
            sdp: peer.localDescription.sdp,
            rtc_trickle: trickle,
            rtc_diagnostics: true,
            rtc_trace_requested: this.traceRequested,
          }),
        );
        offerSent = true;
        for (const candidate of localCandidates)
          this.rawSend(
            "relay",
            JSON.stringify({ type: "rtc-candidate", candidate }),
          );
        this.rtc?.mark("offer_sent");
      }
    } catch {
      this.abandon("setup_error");
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
    const local = stats.get(selected.localCandidateId);
    const remote = stats.get(selected.remoteCandidateId);
    this.tailTraceLocal = candidateNetworkScope(local?.address);
    this.tailTraceRemote = candidateNetworkScope(remote?.address);
    this.tailTraceLocalType = candidateTypeCode(local?.candidateType);
    this.tailTraceRemoteType = candidateTypeCode(remote?.candidateType);
    const hint = tailscaleCandidateHint(local?.address, remote?.address);
    if (this.status.tailscaleCandidate !== hint)
      this.publish({ tailscaleCandidate: hint });
    const types = ["host", "srflx", "prflx"];
    return (
      types.includes(local?.candidateType) &&
      types.includes(remote?.candidateType)
    );
  }

  private async compare() {
    if (
      this.checking ||
      this.promotingAlternative ||
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
      // The data channel may open before Chromium exposes its selected ICE pair.
      // Give the stats time to settle before treating a missing pair as non-direct.
      let directPair = false;
      for (let attempt = 0; attempt < 6 && !directPair; attempt++) {
        if (this.closed || this.channel?.readyState !== "open") return;
        directPair = await this.isDirectPair();
        if (!directPair && attempt < 5)
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!directPair) {
        this.abandon("not_direct");
        return;
      }
      this.rtc?.available();
      this.rtc?.mark("comparing");
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
      const preference = readRoutePreference();
      const target = chooseRoute(relay, direct, this.active, preference);
      const summary = summarize(this.active === "direct" ? direct : relay);
      const rs = summarize(relay),
        ds = summarize(direct);
      const detail = `${preference === "prefer-direct" ? "优先直连" : "自动比较"}：中转 ${rs ? Math.round(rs.median) + " ms" : "不稳定"}，直连 ${ds ? Math.round(ds.median) + " ms" : "不稳定"}；综合延迟、抖动与探测成功率选择`;
      this.publish({ route: this.active, latency: summary?.median, detail });
      if (
        this.pathsAvailable &&
        !this.alternative &&
        Date.now() >= this.nextAlternative
      ) {
        this.nextAlternative = Date.now() + 300000;
        void this.tryAlternative(
          this.tailTraceRemote === 2 ? "native" : "tailnet",
        );
      }
      if (target !== this.active && Date.now() - this.lastSwitch > 30000) {
        this.switchRoute(target);
      }
    } catch {
      if (this.active === "direct") this.fallback();
    } finally {
      this.checking = false;
      if (!this.closed && this.peer)
        this.comparison = this.later(() => void this.compare(), 60000);
    }
  }

  private switchRoute(target: Route): void {
    if (this.pending || this.closed || this.active === target) return;
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

  private retryAlternativeIfDue(): void {
    if (
      !this.pathsAvailable ||
      !this.attempted ||
      this.peer ||
      this.alternative ||
      this.closed ||
      document.hidden ||
      Date.now() < this.nextAlternative
    )
      return;
    this.nextAlternative = Date.now() + 300000;
    this.samples.direct = [];
    void (async () => {
      if (!(await this.tryAlternative("native")) && !this.closed)
        await this.tryAlternative("tailnet");
    })();
  }

  private async tryAlternative(mode: "native" | "tailnet"): Promise<boolean> {
    if (this.closed || this.alternative || document.hidden) return false;
    const path = new AlternativePath(this.iceURLs, (frame) =>
      this.rawSend("relay", JSON.stringify(frame)),
    );
    this.alternative = path;
    this.publish({
      alternative: {
        mode,
        metrics: { state: "measuring", samples: 0, failures: 0 },
      },
    });
    let promoted = false;
    try {
      if (!(await path.connect(mode)) || this.closed || document.hidden) {
        if (!this.closed)
          this.publish({
            alternative: {
              mode,
              metrics: { state: "unavailable", samples: 0, failures: 0 },
            },
          });
        return false;
      }
      const alternate = await path.measure();
      this.publish({
        alternative: { mode, metrics: describeSamples(alternate, Date.now()) },
      });
      if (this.closed || document.hidden || this.pending) return false;
      const alt = summarize(alternate);
      const relay = this.samples.relay;
      if (
        !alt ||
        alt.failures ||
        chooseRoute(relay, alternate, "relay", readRoutePreference()) !==
          "direct"
      )
        return false;
      // Avoid switching for measurement noise; preserve a healthy direct path.
      if (!preferAlternative(this.samples.direct, alternate)) return false;
      if (this.checking) return false;
      this.promotingAlternative = true;
      if (this.active === "direct") {
        this.switchRoute("relay");
        const deadline = Date.now() + 5000;
        while (!this.closed && this.pending && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.closed || this.pending || this.active !== "relay") return false;
      if (!(await path.promote()) || this.closed) return false;
      const oldPeer = this.peer;
      this.peer = path.peer;
      this.channel = path.channel;
      this.channel.onmessage = (event) => this.receive("direct", event.data);
      this.channel.onclose = () => {
        if (this.peer === path.peer) this.abandon("channel_closed");
      };
      this.channel.onerror = () => {
        if (this.peer === path.peer) this.abandon("channel_error");
      };
      path.peer.onconnectionstatechange = () => {
        if (
          this.peer === path.peer &&
          ["failed", "closed"].includes(path.peer.connectionState)
        )
          this.abandon("ice_failed");
      };
      oldPeer?.close();
      promoted = true;
      this.samples.direct = [];
      this.lastSwitch = 0;
      this.publish({ detail: "已发现更合适的候选路径，正在重新比较链路" });
      return true;
    } catch {
      return false; /* The current terminal path remains usable. */
    } finally {
      this.promotingAlternative = false;
      if (this.alternative === path) this.alternative = undefined;
      if (!promoted) path.close();
      if (promoted && !this.closed) void this.compare();
    }
  }

  private async checkHealth() {
    this.retryAlternativeIfDue();
    if (
      this.closed ||
      document.hidden ||
      this.pending ||
      this.checking ||
      this.healthChecking ||
      this.promotingAlternative ||
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
