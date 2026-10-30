import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Radio,
} from "lucide-react";
import {
  formatBytes,
  formatLatency,
  latencyBenefit,
  type PathMetrics,
  type PathState,
  type TransportStatus,
} from "./network-metrics";
import type { Route } from "./transport-policy";

const stateLabel: Record<PathState, string> = {
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
function age(timestamp?: number) {
  if (!timestamp) return "尚未测量";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 2 ? "刚刚更新" : `${seconds} 秒前更新`;
}

export function NetworkPanel({
  status,
  nodeName,
}: {
  status: TransportStatus;
  nodeName?: string;
}) {
  const totalReceive =
    status.traffic.relay.receiveRate + status.traffic.direct.receiveRate;
  const totalSend =
    status.traffic.relay.sendRate + status.traffic.direct.sendRate;
  return (
    <details className="terminal-network" aria-label="终端网络状态">
      <summary>
        {(["relay", "direct"] as const).map((route) => (
          <span
            key={route}
            className={`network-path-summary ${status.route === route ? "selected" : ""}`}
            data-path={route}
          >
            <i
              className={status[route].state === "available" ? "available" : ""}
            />
            <span>{route === "relay" ? "WebSocket" : "WebRTC"}</span>
            <strong>{latency(status[route])}</strong>
            {status.route === route && <small>当前</small>}
          </span>
        ))}
        <span
          className="network-rates"
          title="本终端实际传输速率，方向以浏览器为准"
        >
          <span className="network-download">
            <ArrowDown size={12} />
            {formatBytes(totalReceive)}/s
          </span>
          <span className="network-upload">
            <ArrowUp size={12} />
            {formatBytes(totalSend)}/s
          </span>
        </span>
        <ChevronDown className="network-expand" size={14} />
      </summary>
      <div className="network-details">
        <div className="network-current-route" data-route={status.route}>
          <div>
            <Radio size={14} />
            <b>
              当前使用{" "}
              {status.route === "direct" ? "WebRTC 直连" : "WebSocket 中转"}
            </b>
          </div>
          <p>
            <span>浏览器</span>
            <ArrowRight size={13} />
            {status.route === "relay" && (
              <>
                <span>公网主服务</span>
                <ArrowRight size={13} />
              </>
            )}
            <span>{nodeName || "计算节点"}</span>
          </p>
        </div>
        <div className="network-path-cards">
          {(["relay", "direct"] as Route[]).map((route) => {
            const path = status[route],
              traffic = status.traffic[route];
            return (
              <section
                key={route}
                className={`network-path-card ${status.route === route ? "selected" : ""}`}
                data-state={path.state}
                data-updated-at={path.updatedAt || ""}
                aria-label={
                  route === "relay" ? "WebSocket 中转指标" : "WebRTC 直连指标"
                }
              >
                <div className="network-card-title">
                  <b>{route === "relay" ? "WebSocket 中转" : "WebRTC 直连"}</b>
                  <span>
                    {status.route === route
                      ? "当前链路"
                      : stateLabel[path.state]}
                  </span>
                </div>
                <div className="network-latency">
                  <strong>{latency(path)}</strong>
                  <small>节点往返延迟 RTT</small>
                </div>
                <dl>
                  <div>
                    <dt>延迟抖动</dt>
                    <dd>{formatLatency(path.jitter)}</dd>
                  </div>
                  <div>
                    <dt>近期探测超时</dt>
                    <dd>
                      {path.samples
                        ? `${path.failures} / ${path.samples} 次`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>下行速率</dt>
                    <dd>{formatBytes(traffic.receiveRate)}/s</dd>
                  </div>
                  <div>
                    <dt>上行速率</dt>
                    <dd>{formatBytes(traffic.sendRate)}/s</dd>
                  </div>
                  <div>
                    <dt>累计下行</dt>
                    <dd>{formatBytes(traffic.received)}</dd>
                  </div>
                  <div>
                    <dt>累计上行</dt>
                    <dd>{formatBytes(traffic.sent)}</dd>
                  </div>
                </dl>
                <p className="network-updated">
                  {path.reason || age(path.updatedAt)}
                </p>
              </section>
            );
          })}
        </div>
        <p className="network-comparison">
          {latencyBenefit(status.relay, status.direct)}
        </p>
        <p className="network-selection">{status.detail}</p>
        <p className="network-measurement-note">
          延迟为浏览器到计算节点的往返时间，取最近最多 12
          次探测的中位数；抖动为相邻有效探测的延迟变化均值。每 5
          秒轻量探测，速率约每秒更新。流量只统计本次终端连接的输入输出，不含信令、探测和协议开销，不代表线路带宽上限；探测超时不等于网络丢包率。直连时主服务仍负责登录和管理。
        </p>
      </div>
    </details>
  );
}
