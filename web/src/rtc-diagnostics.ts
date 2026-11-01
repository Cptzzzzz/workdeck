// A deliberately small, allowlisted summary. Never persist SDP, addresses,
// candidate IDs, server URLs, exception text or terminal data.
export type CandidateCounts = Record<string, number>;
export type PairSummary = {
  local: string;
  remote: string;
  state: string;
  count: number;
  requestsSent?: number;
  responsesReceived?: number;
  requestsReceived?: number;
  responsesSent?: number;
};
export type RtcNodeReport = {
  sampleMs: number;
  wire?: {
    requestsSent: number;
    requestsReceived: number;
    successResponsesSent: number;
    successResponsesReceived: number;
    errorResponsesSent: number;
    errorResponsesReceived: number;
    writeErrors: number;
  };
  gathering: string;
  ice: string;
  connection: string;
  stunServers: number;
  localCandidates: CandidateCounts;
  remoteCandidates: CandidateCounts;
  remoteReceived: number;
  remoteApplied: number;
  remoteRejected: number;
  remotePending: number;
  pairs: PairSummary[] | null;
};
export type RtcReport = {
  schema: 1;
  startedAt: number;
  elapsedMs: number;
  stage: string;
  outcome: string;
  gathering: string;
  ice: string;
  connection: string;
  channel: string;
  trickle?: boolean;
  node?: RtcNodeReport;
  nodeLastWithPairs?: RtcNodeReport;
  localCandidates: CandidateCounts;
  remoteCandidates: CandidateCounts;
  gatherMs?: number;
  offerMs?: number;
  answerMs?: number;
  checkingMs?: number;
  openMs?: number;
  sampleMs?: number;
  pairs: PairSummary[] | null;
  stunErrorCodes: number[];
};

const candidateTypes = ["host", "srflx", "prflx", "relay"];
const pairStates = ["frozen", "waiting", "in-progress", "failed", "succeeded"];
const protocols = ["udp", "tcp"];
function allowed(value: unknown, choices: string[]): string {
  return typeof value === "string" && choices.includes(value)
    ? value
    : "unknown";
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000_000)
    : undefined;
}
export function candidateKey(type: unknown, protocol: unknown): string {
  return `${allowed(type, candidateTypes)}/${allowed(typeof protocol === "string" ? protocol.toLowerCase() : protocol, protocols)}`;
}
export function candidateCountsFromSdp(sdp: string): CandidateCounts {
  const result: CandidateCounts = {};
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const match = line.match(
      /^a=candidate:\S+\s+\d+\s+(udp|tcp)\s+\d+\s+\S+\s+\d+\s+typ\s+(host|srflx|prflx|relay)(?:\s|$)/i,
    );
    const key = match
      ? candidateKey(match[2].toLowerCase(), match[1])
      : "unknown/unknown";
    result[key] = Math.min((result[key] || 0) + 1, 10000);
  }
  return result;
}

export function summarizeCandidatePairs(stats: RTCStatsReport): PairSummary[] {
  const groups = new Map<string, PairSummary>();
  stats.forEach((item) => {
    if (item.type !== "candidate-pair") return;
    const pair = item as RTCStats & Record<string, unknown>;
    const local =
      typeof pair.localCandidateId === "string"
        ? stats.get(pair.localCandidateId)
        : undefined;
    const remote =
      typeof pair.remoteCandidateId === "string"
        ? stats.get(pair.remoteCandidateId)
        : undefined;
    const localKey = candidateKey(local?.candidateType, local?.protocol);
    const remoteKey = candidateKey(remote?.candidateType, remote?.protocol);
    const state = allowed(pair.state, pairStates);
    const key = `${localKey}|${remoteKey}|${state}`;
    let group = groups.get(key);
    if (!group) {
      group = { local: localKey, remote: remoteKey, state, count: 0 };
      groups.set(key, group);
    }
    group.count = Math.min(group.count + 1, 10000);
    for (const field of [
      "requestsSent",
      "responsesReceived",
      "requestsReceived",
      "responsesSent",
    ] as const) {
      const value = count(pair[field]);
      if (value !== undefined)
        group[field] = Math.min((group[field] || 0) + value, 1_000_000_000);
    }
  });
  return [...groups.values()].sort((a, b) =>
    `${a.local}|${a.remote}|${a.state}`.localeCompare(
      `${b.local}|${b.remote}|${b.state}`,
    ),
  );
}

const keyPrefix = "workdeck-rtc-diagnostic-v1:";
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
const gatheringStates = ["new", "gathering", "complete"];
const iceStates = [
  "new",
  "checking",
  "connected",
  "completed",
  "failed",
  "disconnected",
  "closed",
];
const connectionStates = [
  "new",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
];
const channelStates = ["connecting", "open", "closing", "closed"];

// Treat sessionStorage as untrusted too; never echo extra fields when copying.
export function cleanReport(value: unknown): RtcReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema !== 1 ||
    typeof raw.startedAt !== "number" ||
    !Number.isSafeInteger(raw.startedAt) ||
    raw.startedAt < 0 ||
    raw.startedAt > 8_640_000_000_000_000
  )
    return undefined;
  const candidates = (input: unknown) => {
    const result: CandidateCounts = {};
    if (input && typeof input === "object")
      for (const [key, val] of Object.entries(input)) {
        const [type, protocol, extra] = key.split("/");
        const n = count(val);
        if (
          !extra &&
          (candidateTypes.includes(type) || type === "unknown") &&
          (protocols.includes(protocol) || protocol === "unknown") &&
          n !== undefined
        )
          result[key] = Math.min(n, 10000);
      }
    return result;
  };
  const result: RtcReport = {
    schema: 1,
    startedAt: raw.startedAt,
    elapsedMs: count(raw.elapsedMs) || 0,
    stage: allowed(raw.stage, stages),
    outcome: allowed(raw.outcome, outcomes),
    gathering: allowed(raw.gathering, gatheringStates),
    ice: allowed(raw.ice, iceStates),
    connection: allowed(raw.connection, connectionStates),
    channel: allowed(raw.channel, channelStates),
    localCandidates: candidates(raw.localCandidates),
    remoteCandidates: candidates(raw.remoteCandidates),
    pairs: null,
    stunErrorCodes: [],
  };
  if (typeof raw.trickle === "boolean") result.trickle = raw.trickle;
  if (raw.node && typeof raw.node === "object") {
    const node = raw.node as Record<string, unknown>;
    const nested = cleanReport({
      schema: 1,
      startedAt: raw.startedAt,
      elapsedMs: 0,
      stage: "unknown",
      outcome: "unknown",
      gathering: node.gathering,
      ice: node.ice,
      connection: node.connection,
      channel: "new",
      localCandidates: node.localCandidates,
      remoteCandidates: node.remoteCandidates,
      pairs: node.pairs,
    });
    const sampleMs = count(node.sampleMs);
    const stunServers = count(node.stunServers);
    const remoteReceived = count(node.remoteReceived);
    const remoteApplied = count(node.remoteApplied);
    const remoteRejected = count(node.remoteRejected);
    const remotePending = count(node.remotePending);
    if (
      nested &&
      sampleMs !== undefined &&
      stunServers !== undefined &&
      remoteReceived !== undefined &&
      remoteApplied !== undefined &&
      remoteRejected !== undefined &&
      remotePending !== undefined
    ) {
      result.node = {
        sampleMs,
        gathering: nested.gathering,
        ice: nested.ice,
        connection: nested.connection,
        stunServers: Math.min(stunServers, 4),
        localCandidates: nested.localCandidates,
        remoteCandidates: nested.remoteCandidates,
        remoteReceived: Math.min(remoteReceived, 128),
        remoteApplied: Math.min(remoteApplied, 128),
        remoteRejected: Math.min(remoteRejected, 128),
        remotePending: Math.min(remotePending, 128),
        pairs: nested.pairs,
      };
      if (node.wire && typeof node.wire === "object") {
        const wire = node.wire as Record<string, unknown>;
        const fields = [
          "requestsSent",
          "requestsReceived",
          "successResponsesSent",
          "successResponsesReceived",
          "errorResponsesSent",
          "errorResponsesReceived",
          "writeErrors",
        ] as const;
        if (fields.every((field) => count(wire[field]) !== undefined)) {
          result.node.wire = Object.fromEntries(
            fields.map((field) => [field, count(wire[field])!]),
          ) as NonNullable<RtcNodeReport["wire"]>;
        }
      }
    }
  }
  if (raw.nodeLastWithPairs && typeof raw.nodeLastWithPairs === "object") {
    const historical = cleanReport({
      schema: 1,
      startedAt: raw.startedAt,
      node: raw.nodeLastWithPairs,
    });
    if (historical?.node?.pairs?.length)
      result.nodeLastWithPairs = historical.node;
  }
  for (const field of [
    "gatherMs",
    "offerMs",
    "answerMs",
    "checkingMs",
    "openMs",
    "sampleMs",
  ] as const) {
    const n = count(raw[field]);
    if (n !== undefined) result[field] = n;
  }
  if (Array.isArray(raw.stunErrorCodes))
    result.stunErrorCodes = raw.stunErrorCodes
      .map(count)
      .filter((n): n is number => n !== undefined && n <= 999)
      .slice(0, 16);
  if (Array.isArray(raw.pairs))
    result.pairs = raw.pairs.slice(0, 128).flatMap((v): PairSummary[] => {
      if (!v || typeof v !== "object") return [];
      const p = v as Record<string, unknown>;
      const normalizeKey = (v: unknown) => {
        if (typeof v !== "string") return "unknown/unknown";
        const parts = v.split("/");
        return parts.length === 2
          ? candidateKey(parts[0], parts[1])
          : "unknown/unknown";
      };
      const item: PairSummary = {
        local: normalizeKey(p.local),
        remote: normalizeKey(p.remote),
        state: allowed(p.state, pairStates),
        count: Math.min(count(p.count) || 0, 10000),
      };
      for (const field of [
        "requestsSent",
        "responsesReceived",
        "requestsReceived",
        "responsesSent",
      ] as const) {
        const n = count(p[field]);
        if (n !== undefined) item[field] = n;
      }
      return [item];
    });
  return result;
}

export function loadRtcReport(terminal: string): RtcReport | undefined {
  if (!/^[a-f0-9]{48}$/.test(terminal)) return undefined;
  try {
    const raw = sessionStorage.getItem(keyPrefix + terminal);
    return raw ? cleanReport(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}
export function saveRtcReport(terminal: string, report: RtcReport): void {
  if (!/^[a-f0-9]{48}$/.test(terminal)) return;
  const clean = cleanReport(report);
  if (!clean) return;
  try {
    sessionStorage.setItem(keyPrefix + terminal, JSON.stringify(clean));
    const keys = Array.from({ length: sessionStorage.length }, (_, i) =>
      sessionStorage.key(i),
    ).filter((key): key is string => !!key && key.startsWith(keyPrefix));
    const others = keys.filter((key) => key !== keyPrefix + terminal);
    for (const key of others.slice(0, Math.max(0, keys.length - 50)))
      sessionStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}

export class RtcRecorder {
  readonly previous?: RtcReport;
  private readonly started = performance.now();
  private finished = false;
  private readonly remoteSeen = new Set<string>();
  private report: RtcReport = {
    schema: 1,
    startedAt: Date.now(),
    elapsedMs: 0,
    stage: "starting",
    outcome: "in_progress",
    gathering: "new",
    ice: "new",
    connection: "new",
    channel: "connecting",
    localCandidates: {},
    remoteCandidates: {},
    pairs: null,
    stunErrorCodes: [],
  };
  constructor(
    private terminal: string,
    private update: (current: RtcReport, previous?: RtcReport) => void,
    trickle: boolean,
  ) {
    this.report.trickle = trickle;
    this.previous = loadRtcReport(terminal);
    this.publish();
  }
  private elapsed() {
    return Math.max(0, Math.round(performance.now() - this.started));
  }
  private publish() {
    if (!this.finished) this.report.elapsedMs = this.elapsed();
    const safe = cleanReport(this.report);
    if (!safe) return;
    if (this.finished || this.report.outcome === "available")
      saveRtcReport(this.terminal, safe);
    this.update(safe, this.previous);
  }
  mark(stage: string) {
    if (this.finished) return;
    if (!(stage === "answer_received" && this.report.checkingMs !== undefined))
      this.report.stage = stage;
    const ms = this.elapsed();
    if (stage === "offer_sent") this.report.offerMs = ms;
    if (stage === "answer_received") this.report.answerMs = ms;
    if (stage === "checking" && this.report.checkingMs === undefined)
      this.report.checkingMs = ms;
    if (stage === "channel_open") this.report.openMs = ms;
    this.publish();
  }
  states(peer: RTCPeerConnection, channel?: RTCDataChannel | null) {
    if (this.finished) return;
    this.report.gathering = allowed(peer.iceGatheringState, gatheringStates);
    this.report.ice = allowed(peer.iceConnectionState, iceStates);
    this.report.connection = allowed(peer.connectionState, connectionStates);
    if (channel)
      this.report.channel = allowed(channel.readyState, channelStates);
    if (
      peer.iceGatheringState === "complete" &&
      this.report.gatherMs === undefined
    )
      this.report.gatherMs = this.elapsed();
    if (
      peer.iceConnectionState === "checking" &&
      this.report.checkingMs === undefined
    ) {
      this.report.checkingMs = this.elapsed();
      this.report.stage = "checking";
    }
    this.publish();
  }
  localCandidate(candidate: RTCIceCandidate) {
    if (this.finished) return;
    const raw = candidate.candidate || "";
    const match = raw.match(
      /\s(udp|tcp)\s.*\styp\s(host|srflx|prflx|relay)(?:\s|$)/i,
    );
    const type = candidate.type || match?.[2]?.toLowerCase();
    const protocol = candidate.protocol || match?.[1]?.toLowerCase();
    const key = candidateKey(type, protocol);
    this.report.localCandidates[key] = Math.min(
      (this.report.localCandidates[key] || 0) + 1,
      10000,
    );
    this.publish();
  }
  remoteDescription(sdp: string) {
    if (this.finished) return;
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith("a=candidate:")) this.remoteCandidate(line.slice(2));
    }
  }
  remoteCandidate(candidate: string) {
    if (
      this.finished ||
      !candidate.startsWith("candidate:") ||
      this.remoteSeen.has(candidate) ||
      this.remoteSeen.size >= 128
    )
      return;
    this.remoteSeen.add(candidate);
    const counts = candidateCountsFromSdp(`a=${candidate}`);
    for (const [key, value] of Object.entries(counts))
      this.report.remoteCandidates[key] =
        (this.report.remoteCandidates[key] || 0) + value;
    this.publish();
  }
  nodeDiagnostic(node: unknown) {
    const safe = cleanReport({ ...this.report, node });
    if (!safe?.node) return;
    const previous = this.report.node;
    if (safe.node.pairs?.length) {
      this.report.nodeLastWithPairs = undefined;
    } else if (previous?.pairs?.length) {
      this.report.nodeLastWithPairs = previous;
    }
    this.report.node = safe.node;
    this.publish();
  }
  stunError(code: number) {
    if (this.finished) return;
    if (
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 999 &&
      !this.report.stunErrorCodes.includes(code)
    )
      this.report.stunErrorCodes.push(code);
    this.report.stunErrorCodes = this.report.stunErrorCodes.slice(0, 16);
    this.publish();
  }
  async sample(peer: RTCPeerConnection) {
    if (this.finished) return;
    try {
      const stats = await peer.getStats();
      if (this.finished) return;
      this.report.pairs = summarizeCandidatePairs(stats);
      this.report.sampleMs = this.elapsed();
      this.publish();
    } catch {
      /* Unsupported stats remain unknown. */
    }
  }
  available() {
    if (this.finished) return;
    this.report.outcome = "available";
    this.publish();
  }
  cancel() {
    if (this.report.outcome !== "available") this.finish("cancelled");
  }
  finish(outcome: string) {
    if (this.finished) return;
    this.finished = true;
    this.report.outcome = allowed(outcome, outcomes);
    this.report.stage = "finished";
    this.publish();
  }
}
