import type { ComputeNode, TerminalRecord } from "./types";

export function codexStatus(terminal?: TerminalRecord, node?: ComputeNode) {
  const raw = terminal?.task?.codex_status;
  if (!raw && terminal?.task?.codex_detected)
    return { text: "检测到 Codex，状态未知", kind: "unknown" };
  if (!raw) return null;
  if (
    !node?.online ||
    terminal?.state !== "running" ||
    terminal?.desired_state === "closed"
  )
    return { text: "Codex 状态未知", kind: "unknown" };
  if (terminal?.task?.codex_detected === false && raw !== "session_ended")
    return { text: "Codex 状态未知", kind: "unknown" };
  const state: Record<string, { text: string; kind: string }> = {
    ready: { text: "Codex 已启动", kind: "ready" },
    running: { text: "Codex 工作中", kind: "running" },
    attention: { text: "Codex 可能需要处理", kind: "attention" },
    turn_ended: { text: "Codex 可能已完成，待查看", kind: "done" },
    interrupted: { text: "Codex 已中断", kind: "attention" },
    session_ended: { text: "Codex 会话结束", kind: "unknown" },
    unknown: { text: "Codex 状态未知", kind: "unknown" },
  };
  return state[raw] || null;
}
