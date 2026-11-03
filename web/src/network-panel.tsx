import { Select, ownsSelectPopup } from "./components/select";
import { readTailnetProbe, subscribeTailnetProbe } from "./tailnet-probe";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  ArrowRight,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Radio,
  Activity,
  Cable,
  Globe2,
  Network,
  ShieldCheck,
  X,
  Gauge,
  LoaderCircle,
} from "lucide-react";
import {
  formatBytes,
  formatLatency,
  latencyBenefit,
  type PathMetrics,
  type PathState,
  type TransportStatus,
  type Traffic,
  type RelayProtocol,
  type TestPath,
} from "./network-metrics";
import { RtcDiagnosticPanel } from "./rtc-diagnostic-panel";
import {
  readRoutePreference,
  saveRoutePreference,
  subscribeRoutePreference,
} from "./transport-preferences";

const stateLabel: Record<PathState, string> = {
  paused: "已暂停",
  pending: "等待测量",
  measuring: "检测中",
  available: "可用",
  timeout: "探测超时",
  unavailable: "不可用",
  unsupported: "不支持",
  disabled: "已关闭",
  cooldown: "暂缓检测",
};
function latency(path: PathMetrics) {
  if (
    path.state === "available" &&
    path.updatedAt &&
    Date.now() - path.updatedAt > 20000
  )
    return "待刷新";
  return path.state === "available"
    ? formatLatency(path.latency)
    : stateLabel[path.state];
}
function candidateBadge(metrics: PathMetrics) {
  if (metrics.state !== "available") return stateLabel[metrics.state];
  return !metrics.updatedAt || Date.now() - metrics.updatedAt > 20000
    ? "历史测量"
    : "已测可用";
}
function age(timestamp?: number) {
  if (!timestamp) return "尚未测量";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 2 ? "刚刚更新" : `${seconds} 秒前更新`;
}

type LinkCard = {
  id: TestPath;
  name: string;
  category: string;
  badge: string;
  note: string;
  icon: typeof Radio;
  selected?: boolean;
  metrics?: PathMetrics;
  traffic?: Traffic;
  handshakeMs?: number;
  attempts?: number;
  test?: PathMetrics;
  manualDisplay?: boolean;
};
function relayCard(status: TransportStatus, protocol: RelayProtocol): LinkCard {
  const ownsRelay = (status.relayProtocol || "websocket") === protocol;
  const candidate = status.relayCandidates?.[protocol];
  const metrics = ownsRelay ? status.relay : undefined;
  const selected =
    status.route === "relay" &&
    ownsRelay &&
    (!!status.relayProtocol || status.relay.state === "available");
  const labels = {
    connecting: "连接中",
    open: "备用就绪",
    cancelled: "未采用",
    failed: "建连失败",
  };
  return {
    id: protocol,
    name: protocol === "websocket" ? "WebSocket 中转" : "HTTP 流式中转",
    category: protocol === "websocket" ? "持久双向通道" : "HTTPS 流式回退",
    icon: protocol === "websocket" ? Cable : Globe2,
    selected,
    metrics,
    traffic: ownsRelay ? status.traffic.relay : undefined,
    handshakeMs: candidate?.handshakeMs,
    attempts: candidate?.attempts,
    badge: selected
      ? "当前使用"
      : ownsRelay && metrics?.state === "available"
        ? "备用就绪"
        : candidate
          ? labels[candidate.state]
          : "未启用",
    note: ownsRelay
      ? metrics?.reason || age(metrics?.updatedAt)
      : candidate?.state === "cancelled"
        ? "另一条通道已就绪，本次尝试已取消。"
        : candidate?.state === "failed"
          ? "本次建连未成功，不影响其他可用通道。"
          : candidate?.state === "connecting"
            ? "正在尝试建立通道，终端优先使用先就绪的链路。"
            : "按需尝试，不额外占用连接；未测量节点 RTT。",
  };
}
function NetworkLinkCard({
  card,
  testing,
  busy,
  onTest,
}: {
  card: LinkCard;
  testing?: boolean;
  busy?: boolean;
  onTest?: (path: TestPath) => void;
}) {
  const Icon = card.icon;
  return (
    <section
      className={`network-path-card ${card.selected ? "selected" : ""}`}
      data-state={card.metrics?.state || "pending"}
      data-updated-at={card.metrics?.updatedAt || ""}
      aria-label={`${card.name}指标`}
    >
      <div className="network-card-title">
        <span className="network-card-icon">
          <Icon size={17} />
        </span>
        <div>
          <b>{card.name}</b>
          <small>{card.category}</small>
        </div>
        <span className={`network-card-badge ${card.selected ? "active" : ""}`}>
          {card.selected && <Radio size={10} />} {card.badge}
        </span>
      </div>
      <div className="network-latency">
        <strong>
          {card.manualDisplay
            ? formatLatency(card.metrics?.latency)
            : card.metrics?.state === "available"
              ? latency(card.metrics)
              : "—"}
        </strong>
        <small>{card.manualDisplay ? "最近手动 RTT" : "节点往返 RTT"}</small>
      </div>
      <div className="network-card-rates">
        <span>
          <ArrowDown size={13} />
          <b>
            {card.traffic ? `${formatBytes(card.traffic.receiveRate)}/s` : "—"}
          </b>
          <small>下行</small>
        </span>
        <span>
          <ArrowUp size={13} />
          <b>
            {card.traffic ? `${formatBytes(card.traffic.sendRate)}/s` : "—"}
          </b>
          <small>上行</small>
        </span>
      </div>
      <p className="network-updated" role={card.test ? "status" : undefined}>
        {card.test
          ? card.test.reason ||
            (card.test.state === "measuring"
              ? "正在采样，不切换当前链路。"
              : `手动测试 ${latency(card.test)} · ${card.test.samples} 次 · ${age(card.test.updatedAt)}`)
          : card.note}
      </p>
      <button
        type="button"
        className="network-test-button"
        disabled={!onTest || busy}
        onClick={() => onTest?.(card.id)}
        aria-label={`测试${card.name}延迟`}
        aria-busy={testing || undefined}
      >
        {testing ? (
          <LoaderCircle className="network-test-spinner" size={13} />
        ) : (
          <Gauge size={13} />
        )}
        {testing ? "测试中…" : "测试延迟"}
      </button>
      <details className="network-card-extra">
        <summary>
          详细指标
          <ChevronDown size={12} />
        </summary>
        <dl>
          {card.test?.updatedAt && (
            <div>
              <dt>最近手动测试</dt>
              <dd>
                {card.test.state === "available"
                  ? formatLatency(card.test.latency)
                  : stateLabel[card.test.state]}{" "}
                · {age(card.test.updatedAt)}
              </dd>
            </div>
          )}
          <div>
            <dt>延迟抖动</dt>
            <dd>{formatLatency(card.metrics?.jitter)}</dd>
          </div>
          <div>
            <dt>近期探测超时</dt>
            <dd>
              {card.metrics?.samples
                ? `${card.metrics.failures} / ${card.metrics.samples} 次`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>累计下行 / 上行</dt>
            <dd>
              {card.traffic
                ? `${formatBytes(card.traffic.received)} / ${formatBytes(card.traffic.sent)}`
                : "—"}
            </dd>
          </div>
          {card.handshakeMs !== undefined && (
            <div>
              <dt>初始建连耗时</dt>
              <dd>{formatLatency(card.handshakeMs)}</dd>
            </div>
          )}
          {card.attempts !== undefined && (
            <div>
              <dt>初始建连尝试</dt>
              <dd>{card.attempts} 次</dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}

export function NetworkPanel({
  status,
  nodeName,
  onRetryDirect,
  onTestPath,
}: {
  status: TransportStatus;
  nodeName?: string;
  onRetryDirect?: () => void;
  onTestPath?: (path: TestPath) => void;
}) {
  const tailnet = useSyncExternalStore(subscribeTailnetProbe, readTailnetProbe);
  const details = useRef<HTMLDetailsElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const preference = useSyncExternalStore(
    subscribeRoutePreference,
    readRoutePreference,
  );
  useEffect(() => {
    const fitPopup = () => {
      const anchor = details.current,
        panel = popup.current;
      if (!anchor?.open || !panel) return;
      const bounds = anchor.getBoundingClientRect();
      panel.style.right = "0px";
      const rect = panel.getBoundingClientRect();
      if (rect.left < 12) panel.style.right = `${rect.left - 12}px`;
      else if (rect.right > window.innerWidth - 12)
        panel.style.right = `${rect.right - window.innerWidth + 12}px`;
      const above = bounds.top - 20;
      if (above < 160 && window.innerHeight - bounds.bottom > above) {
        panel.style.top = "calc(100% + 8px)";
        panel.style.bottom = "auto";
        panel.style.maxHeight = `${Math.max(0, Math.min(720, window.innerHeight - bounds.bottom - 20))}px`;
      } else {
        panel.style.top = "auto";
        panel.style.bottom = "calc(100% + 8px)";
        panel.style.maxHeight = `${Math.max(0, Math.min(720, above))}px`;
      }
    };
    const dismiss = (event: PointerEvent) => {
      if (
        details.current &&
        !details.current.contains(event.target as Node) &&
        !ownsSelectPopup(event.target, details.current)
      )
        details.current.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.current?.open) {
        details.current.open = false;
        details.current.querySelector<HTMLElement>("summary")?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", fitPopup);
    window.addEventListener("workdeck:resize-end", fitPopup);
    const anchor = details.current;
    const onToggle = () => requestAnimationFrame(fitPopup);
    anchor?.addEventListener("toggle", onToggle);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", fitPopup);
      window.removeEventListener("workdeck:resize-end", fitPopup);
      anchor?.removeEventListener("toggle", onToggle);
    };
  }, []);
  const connecting =
    status.route === "relay" &&
    !status.relayProtocol &&
    !!status.relayCandidates &&
    status.relay.state !== "available";
  const relayName =
    status.relayProtocol === "http-stream" ? "HTTP 流式中转" : "WebSocket 中转";
  const currentName = connecting
    ? "正在连接"
    : status.route === "direct"
      ? "WebRTC 直连"
      : relayName;
  const tailMetrics =
    status.alternatives?.tailnet ||
    (status.alternative?.mode === "tailnet"
      ? status.alternative.metrics
      : undefined);
  const nativeMetrics =
    status.alternatives?.native ||
    (status.alternative?.mode === "native"
      ? status.alternative.metrics
      : undefined);
  const cards: LinkCard[] = [
    relayCard(status, "websocket"),
    relayCard(status, "http-stream"),
    {
      id: "webrtc",
      name: "WebRTC 直连",
      category: "浏览器与节点的数据通道",
      icon: Network,
      selected: status.route === "direct",
      badge:
        status.route === "direct"
          ? "当前使用"
          : stateLabel[status.direct.state],
      metrics: status.direct,
      traffic: status.traffic.direct,
      note:
        status.direct.reason ||
        (status.tailscaleCandidate === "possible"
          ? "所选候选可能经 Tailscale，底层直连状态尚未确认。"
          : age(status.direct.updatedAt)),
    },
    {
      id: "tailnet",
      name: "Tailnet 候选",
      category: "WebRTC 的可选网络路径",
      icon: ShieldCheck,
      badge: tailMetrics
        ? candidateBadge(tailMetrics)
        : tailnet === "available"
          ? "主服务可达"
          : tailnet === "checking"
            ? "探测中"
            : tailnet === "disabled"
              ? "未配置"
              : "未确认",
      metrics: tailMetrics,
      note: tailMetrics
        ? tailMetrics.reason ||
          `${age(tailMetrics.updatedAt)}；流量计入 WebRTC，Tailscale 也可能经中继。`
        : tailnet === "available"
          ? "本设备可经 Tailnet 访问主服务，计算节点路径尚未测量。"
          : tailnet === "checking"
            ? "正在验证本设备到主服务的 Tailnet 连接。"
            : tailnet === "disabled"
              ? "未启用 Tailnet 探测；不影响公网中转及原生 WebRTC。"
              : "暂未确认本设备的 Tailnet 连接，不影响现有链路。",
    },
  ];
  if (nativeMetrics)
    cards.push({
      id: "native",
      name: "其他接口候选",
      category: "WebRTC 的其他网络路径",
      icon: Network,
      badge: candidateBadge(nativeMetrics),
      metrics: nativeMetrics,
      note:
        nativeMetrics.reason ||
        `${age(nativeMetrics.updatedAt)}；候选接口测量，流量计入 WebRTC。`,
    });
  for (const card of cards) {
    const result = status.manualTests?.[card.id];
    if (!result) continue;
    card.test = result;
    const live = card.selected;
    if (!live) {
      card.manualDisplay = true;
      card.metrics = result;
      card.badge =
        result.state === "available"
          ? candidateBadge(result)
          : stateLabel[result.state];
      card.note =
        result.reason ||
        (result.state === "measuring"
          ? "临时测量中，当前终端链路保持不变。"
          : `手动测试 · ${age(result.updatedAt)}；未切换当前链路。`);
    }
  }
  return (
    <details
      ref={details}
      className="terminal-network"
      aria-label="终端网络状态"
    >
      <summary title={`${status.detail}；点击查看终端网络详情`}>
        <span
          className="network-path-summary selected"
          data-path={status.route}
        >
          <i
            className={
              status[status.route].state === "available" ? "available" : ""
            }
          />
          <span>
            {connecting
              ? "连接中"
              : status.route === "relay"
                ? status.relayProtocol === "http-stream"
                  ? "HTTP"
                  : "WebSocket"
                : "WebRTC"}
          </span>
          <strong>{connecting ? "—" : latency(status[status.route])}</strong>
        </span>
        <ChevronDown className="network-expand" size={14} />
      </summary>
      <div className="network-details" ref={popup}>
        <div className="network-popover-header">
          <div>
            <Activity size={17} />
            <h3>网络详情</h3>
            <span>自动检测 · 优先保持可用</span>
          </div>
          <button
            type="button"
            aria-label="关闭网络详情"
            onClick={() => {
              if (details.current) {
                details.current.open = false;
                details.current.querySelector<HTMLElement>("summary")?.focus();
              }
            }}
          >
            <X size={16} />
          </button>
        </div>
        <div
          className="network-current-route"
          data-route={status.route}
          data-state={connecting ? "connecting" : "connected"}
        >
          <div className="network-current-copy">
            <span className="network-eyebrow">
              <i />
              {connecting ? "正在寻找可用通道" : "当前使用的链路"}
            </span>
            <b>{currentName}</b>
            <p>
              <span>浏览器</span>
              <ArrowRight size={12} />
              {status.route === "relay" && (
                <>
                  <span>主服务</span>
                  <ArrowRight size={12} />
                </>
              )}
              <span>{nodeName || "计算节点"}</span>
            </p>
          </div>
          <div className="network-current-latency">
            <strong>{connecting ? "—" : latency(status[status.route])}</strong>
            <small>到节点的往返延迟</small>
          </div>
        </div>
        <div className="network-policy-section">
          <label className="network-route-preference">
            <span>
              链路策略<small>终端与文件共用此设置</small>
            </span>
            <Select
              aria-label="链路策略"
              value={preference}
              options={[
                { value: "prefer-direct", label: "优先直连" },
                { value: "balanced", label: "平衡延迟" },
              ]}
              onChange={(value) =>
                saveRoutePreference(
                  value === "balanced" ? "balanced" : "prefer-direct",
                )
              }
            />
          </label>
          <p>
            {status.discovery === "settled"
              ? "已暂停其他路径的自动探测，仅检查当前链路；手动测试不切换链路，重新连接时再应用策略。"
              : "可用通道先显示内容，初始阶段后台比较；稳定后仅检查当前链路，故障时重新探测。"}
          </p>
        </div>
        <div className="network-section-heading">
          <b>全部链路</b>
          <span>
            {status.discovery === "settled"
              ? "自动探测已暂停 · 可手动测试"
              : "稳定后暂停其他路径探测"}
          </span>
        </div>
        <div className="network-path-cards">
          {cards.map((card) => (
            <NetworkLinkCard
              key={card.id}
              card={card}
              testing={status.testingPath === card.id}
              busy={!!status.testingPath}
              onTest={onTestPath}
            />
          ))}
        </div>
        <p className="network-comparison">
          {latencyBenefit(
            status.relay,
            status.direct,
            Date.now(),
            status.relayProtocol === "http-stream" ? "HTTP 流" : "WebSocket",
          )}
        </p>
        <p className="network-selection">{status.detail}</p>
        <RtcDiagnosticPanel
          current={status.rtcDiagnostic}
          previous={status.previousRtcDiagnostic}
        />
        {onRetryDirect &&
          status.route === "relay" &&
          ["unavailable", "timeout", "cooldown"].includes(
            status.direct.state,
          ) && (
            <button
              type="button"
              className="secondary network-retry"
              onClick={onRetryDirect}
            >
              重新检测直连（重连此终端）
            </button>
          )}
        <details className="network-explanation">
          <summary>
            指标与链路说明
            <ChevronDown size={12} />
          </summary>
          <p>
            RTT 是浏览器到计算节点的往返延迟，取最近最多 12 次探测的中位数；每 5
            秒轻量探测，速率约每秒更新。建连耗时与 RTT
            是不同指标。流量只统计本次连接的终端输入输出，不含信令、探测及协议开销，不代表带宽上限；探测超时不等于丢包率。Tailnet
            是 WebRTC 可选的网络路径，不是单独的传输协议，也不保证绕过 Tailscale
            的中继服务。
          </p>
        </details>
      </div>
    </details>
  );
}
