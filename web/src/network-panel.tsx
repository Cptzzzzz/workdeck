import { useEffect, useRef, useSyncExternalStore } from "react";
import { ArrowRight, ChevronDown, Radio } from "lucide-react";
import {
  formatBytes,
  formatLatency,
  latencyBenefit,
  type PathMetrics,
  type PathState,
  type TransportStatus,
} from "./network-metrics";
import type { Route } from "./transport-policy";
import { RtcDiagnosticPanel } from "./rtc-diagnostic-panel";
import {
  readRoutePreference,
  saveRoutePreference,
  subscribeRoutePreference,
} from "./transport-preferences";

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
  onRetryDirect,
}: {
  status: TransportStatus;
  nodeName?: string;
  onRetryDirect?: () => void;
}) {
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
        panel.style.maxHeight = `${Math.max(0, Math.min(500, window.innerHeight - bounds.bottom - 20))}px`;
      } else {
        panel.style.top = "auto";
        panel.style.bottom = "calc(100% + 8px)";
        panel.style.maxHeight = `${Math.max(0, Math.min(500, above))}px`;
      }
    };
    const dismiss = (event: PointerEvent) => {
      if (details.current && !details.current.contains(event.target as Node))
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
          <span>{status.route === "relay" ? "WebSocket" : "WebRTC"}</span>
          <strong>{latency(status[status.route])}</strong>
        </span>
        <ChevronDown className="network-expand" size={14} />
      </summary>
      <div className="network-details" ref={popup}>
        <label className="network-route-preference">
          链路策略
          <select
            value={preference}
            onChange={(event) =>
              saveRoutePreference(
                event.target.value === "balanced"
                  ? "balanced"
                  : "prefer-direct",
              )
            }
          >
            <option value="prefer-direct">优先直连</option>
            <option value="balanced">平衡延迟</option>
          </select>
        </label>
        <p className="network-measurement-note">
          策略同时用于终端和文件连接；直连不稳定或延迟过高时仍自动中转，下一轮检测时生效。
        </p>
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
        <RtcDiagnosticPanel
          current={status.rtcDiagnostic}
          previous={status.previousRtcDiagnostic}
        />
        {onRetryDirect &&
          status.route === "relay" &&
          ["unavailable", "timeout", "cooldown"].includes(
            status.direct.state,
          ) && (
            <button type="button" className="secondary" onClick={onRetryDirect}>
              重新检测直连（重连此终端）
            </button>
          )}
        <p className="network-measurement-note">
          延迟为浏览器到计算节点的往返时间，取最近最多 12
          次探测的中位数；抖动为相邻有效探测的延迟变化均值。每 5
          秒轻量探测，速率约每秒更新。流量只统计本次终端连接的输入输出，不含信令、探测和协议开销，不代表线路带宽上限；探测超时不等于网络丢包率。直连时主服务仍负责登录和管理。
        </p>
      </div>
    </details>
  );
}
