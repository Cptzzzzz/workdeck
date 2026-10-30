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
};
export type Snapshot = { nodes: ComputeNode[]; terminals: TerminalRecord[] };
export type User = { username: string; csrf: string };

export type RenameTarget = {
  kind: "node" | "terminal";
  id: string;
  name: string;
};
