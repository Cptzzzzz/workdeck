import type { ComputeNode, TerminalRecord } from "./types";

export function isCodexTask(terminal?: TerminalRecord) {
  return terminal?.kind === "codex" || terminal?.task?.codex?.managed === true;
}

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
    goal_active: { text: "Codex Goal 执行中", kind: "running" },
    goal_complete: { text: "Codex Goal 已完成", kind: "done" },
    goal_paused: { text: "Codex Goal 已暂停", kind: "attention" },
    goal_blocked: { text: "Codex Goal 受阻，需处理", kind: "attention" },
    goal_budget_limited: { text: "Codex Goal 预算已耗尽", kind: "attention" },
    goal_usage_limited: { text: "Codex Goal 达到用量限制", kind: "attention" },
    running: { text: "Codex 工作中", kind: "running" },
    attention: { text: "Codex 可能需要处理", kind: "attention" },
    turn_ended: {
      text: terminal?.task?.codex?.managed
        ? "Codex 本轮已结束"
        : "Codex 可能已完成，待查看",
      kind: "done",
    },
    interrupted: { text: "Codex 已中断", kind: "attention" },
    session_ended: { text: "Codex 会话结束", kind: "unknown" },
    unknown: { text: "Codex 状态未知", kind: "unknown" },
  };
  return state[raw] || null;
}
