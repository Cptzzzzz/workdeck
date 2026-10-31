import { useState } from "react";
import { cleanReport, type RtcReport } from "./rtc-diagnostics";

const stageNames: Record<string, string> = {
  starting: "开始",
  gathering: "收集本地候选",
  offer_sent: "已发送浏览器候选",
  answer_received: "已收到节点应答",
  checking: "检查候选连接",
  channel_open: "数据通道已建立",
  comparing: "比较链路",
  finished: "已结束",
  unknown: "未知",
};
const outcomeNames: Record<string, string> = {
  in_progress: "进行中",
  available: "直连通道可用",
  timeout: "建立数据通道超时",
  ice_failed: "ICE 或连接状态失败",
  peer_closed: "连接已关闭",
  channel_closed: "数据通道关闭",
  channel_error: "数据通道错误",
  answer_error: "节点应答处理失败",
  agent_unavailable: "节点报告协商不可用",
  setup_error: "浏览器协商异常",
  not_direct: "未确认是直接候选对",
  route_interrupted: "直连中断或切换未完成",
  cancelled: "检测被关闭或连接重建",
  unknown: "未知",
};
function elapsed(ms?: number) {
  return ms === undefined ? "未记录" : `${ms} ms`;
}
function counts(items: Record<string, number>) {
  const entries = Object.entries(items);
  return entries.length
    ? entries.map(([type, n]) => `${type}：${n}`).join("，")
    : "未收集到或不可用";
}
function details(report: RtcReport) {
  const safe = cleanReport(report);
  return safe ? JSON.stringify(safe, null, 2) : "";
}

export function RtcDiagnosticPanel({
  current,
  previous,
}: {
  current?: RtcReport;
  previous?: RtcReport;
}) {
  const [message, setMessage] = useState("");
  const report = current || previous;
  if (!report)
    return (
      <p className="network-measurement-note">
        暂无终端直连诊断；建立连接后自动采集。
      </p>
    );
  const previousIsDifferent =
    !!current && !!previous && current.startedAt !== previous.startedAt;
  return (
    <details className="rtc-diagnostic" aria-label="WebRTC 直连诊断">
      <summary>直连诊断 · {outcomeNames[report.outcome] || "未知"}</summary>
      <div className="rtc-diagnostic-body">
        <p>
          {current ? "本次检测" : "本标签页最近一次检测"} ·{" "}
          {new Date(report.startedAt).toLocaleString()}
        </p>
        <dl>
          <div>
            <dt>结果 / 阶段</dt>
            <dd>
              {outcomeNames[report.outcome] || "未知"} /{" "}
              {stageNames[report.stage] || "未知"}
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              收集 {report.gathering} · ICE {report.ice} · 连接{" "}
              {report.connection} · 通道 {report.channel}
            </dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd>
              收集 {elapsed(report.gatherMs)} · 发出 {elapsed(report.offerMs)} ·
              应答 {elapsed(report.answerMs)} · 检查{" "}
              {elapsed(report.checkingMs)} · 通道 {elapsed(report.openMs)} ·
              总计 {elapsed(report.elapsedMs)}
            </dd>
          </div>
          <div>
            <dt>候选交换</dt>
            <dd>
              {report.trickle === undefined
                ? "未记录"
                : report.trickle
                  ? "增量交换"
                  : "一次性协商（兼容旧节点）"}
            </dd>
          </div>
          <div>
            <dt>浏览器候选</dt>
            <dd>{counts(report.localCandidates)}</dd>
          </div>
          <div>
            <dt>节点应答候选</dt>
            <dd>{counts(report.remoteCandidates)}</dd>
          </div>
          <div>
            <dt>STUN 错误码</dt>
            <dd>
              {report.stunErrorCodes.length
                ? report.stunErrorCodes.join("、")
                : "未报告"}
            </dd>
          </div>
        </dl>
        <p>候选对统计（最后一次采样：{elapsed(report.sampleMs)}）</p>
        {report.pairs === null ? (
          <p>浏览器未提供统计或采样尚未完成。</p>
        ) : report.pairs.length === 0 ? (
          <p>采样时没有候选对。</p>
        ) : (
          <div className="rtc-pair-list">
            {report.pairs.map((pair) => (
              <p key={`${pair.local}-${pair.remote}-${pair.state}`}>
                {pair.local} → {pair.remote} · {pair.state} × {pair.count} ·
                发请求 {pair.requestsSent ?? "—"} / 收响应{" "}
                {pair.responsesReceived ?? "—"} · 收请求{" "}
                {pair.requestsReceived ?? "—"} / 发响应{" "}
                {pair.responsesSent ?? "—"}
              </p>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(details(report)).then(
              () => setMessage("诊断摘要已复制"),
              () => setMessage("复制失败，请检查浏览器剪贴板权限"),
            )
          }
        >
          复制诊断摘要
        </button>
        {previousIsDifferent && (
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(details(previous!)).then(
                () => setMessage("上次诊断摘要已复制"),
                () => setMessage("复制失败，请检查浏览器剪贴板权限"),
              )
            }
          >
            复制上次摘要
          </button>
        )}
        {message && <span role="status">{message}</span>}
        <p>
          仅保存在本浏览器标签页，刷新后保留、关闭标签页后清除；不包含
          IP、端口、SDP、候选 ID
          或终端内容。候选对和计数取决于浏览器支持，未记录不等于零。
        </p>
      </div>
    </details>
  );
}
