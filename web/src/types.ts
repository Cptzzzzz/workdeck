export type NodeHardware = {
  collected_at: string;
  cpu_model?: string;
  logical_cpus?: number;
  physical_cores?: number;
  memory_bytes?: number;
  memory_modules?: { vendor?: string; model?: string; size_bytes?: number }[];
  disks?: {
    name: string;
    model?: string;
    vendor?: string;
    size_bytes?: number;
  }[];
  gpus?: { model: string; memory_bytes?: number }[];
};
export type ComputeNode = {
  has_codex_proxy?: boolean;
  run_user?: string;
  version?: string;
  hardware?: NodeHardware | null;
  id: string;
  name: string;
  online: boolean;
  hostname: string;
  home: string;
  platform: string;
  last_seen: string;
  shell: string;
  capabilities?: string[];
};
export type TerminalRecord = {
  kind?: "terminal" | "codex";
  id: string;
  node_id: string;
  name: string;
  cwd: string;
  state: string;
  desired_state: string;
  created_at: string;
  updated_at: string;
  error: string;
  viewers: number;
  exit_code: number | null;
  task?: {
    note: string;
    tags: string;
    important: boolean;
    manual_status: string;
    codex_turn: string;
    codex_completed_at: string;
    codex_command: string;
    codex_status: string;
    codex_event: string;
    codex_observed_at: string;
    codex_detected: boolean | null;
    codex?: {
      managed?: boolean;
      thread_id?: string;
      goal?: {
        status: string;
        tokens_used: number;
        token_budget?: number;
        time_used_seconds: number;
        created_at: number;
      };
    };
  };
};
export type Snapshot = { nodes: ComputeNode[]; terminals: TerminalRecord[] };
export type User = { username: string; csrf: string };

export type RenameTarget = {
  kind: "node" | "terminal";
  id: string;
  name: string;
};
