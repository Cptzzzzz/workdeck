export type Workspace = {
  id: string;
  terminal_id: string;
  root_path: string;
  root_revision: number;
  run_user: string;
};
export type WorkspaceView = {
  initialized: boolean;
  state?: "initializing" | "ready" | "changing";
  workspace?: Workspace;
  pending_target?: string;
};
export type FileEntry = {
  name: string;
  kind: "file" | "directory" | "symlink" | "special";
  size: number;
  mode: number;
  modified: string;
  version?: string;
  sha256?: string;
  restricted: boolean;
};
export type DirectoryPage = {
  path: string;
  snapshot: string;
  entries: FileEntry[];
  next: number;
  has_more: boolean;
  truncated: boolean;
};
export type FileOperation = {
  id: string;
  workspace_id: string;
  root_revision: number;
  kind: string;
  state: string;
  offset: number;
  version?: string;
  error?: { code: string; message: string };
};
export type SaveSpec = {
  path: string;
  base_version?: string;
  size: number;
  sha256: string;
  create?: boolean;
};
export type SaveTransaction = {
  opID: string;
  spec: SaveSpec;
  content: Uint8Array;
};
export type UploadTransaction = {
  opID: string;
  spec: SaveSpec;
  sourceName: string;
};
