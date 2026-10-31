export type ComputeNode = {
  run_user?: string;
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
  };
};
export type Snapshot = { nodes: ComputeNode[]; terminals: TerminalRecord[] };
export type User = { username: string; csrf: string };

export type RenameTarget = {
  kind: "node" | "terminal";
  id: string;
  name: string;
};
