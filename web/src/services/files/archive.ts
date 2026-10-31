import type { CreateIntent } from "./drafts";
import type { ArchivedOperation } from "./types";

// A status is useful only for the exact local intent, never merely because
// a path happens to have the same name in another root or workspace.
export function matchesArchivedIntent(
  intent: CreateIntent,
  result: ArchivedOperation,
): boolean {
  if (
    result.id !== intent.opID ||
    result.workspace_id !== intent.workspaceID ||
    result.root_revision !== intent.rootRevision ||
    result.path !== intent.path
  )
    return false;
  switch (intent.kind) {
    case "file":
      return (
        result.kind === "write" &&
        result.write?.create === true &&
        result.write.size === 0 &&
        result.write.sha256 ===
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    case "upload":
      return (
        result.kind === "write" &&
        result.write?.create === true &&
        result.write.size === intent.size &&
        result.write.sha256 === intent.sha256
      );
    case "directory":
      return result.kind === "directory.create";
    case "rename":
      return (
        result.kind === "entry.rename" &&
        !!intent.source &&
        result.source === intent.source
      );
    case "delete":
      return (
        result.kind === "entry.delete" &&
        !!result.recursive === !!intent.recursive
      );
  }
}
