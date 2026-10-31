import { test, expect } from "@playwright/test";
import { matchesArchivedIntent } from "../src/services/files/archive";
import type { CreateIntent } from "../src/services/files/drafts";
import type { ArchivedOperation } from "../src/services/files/types";

test("old operation results must match the full local scope and target", () => {
  const intent: CreateIntent = {
    account: "test",
    nodeID: "node",
    workspaceID: "workspace",
    rootRevision: 1,
    opID: "operation",
    kind: "upload",
    path: "folder/data.bin",
    size: 4,
    sha256: "a".repeat(64),
    createdAt: 1,
  };
  const result: ArchivedOperation = {
    id: intent.opID,
    workspace_id: intent.workspaceID,
    root_revision: 1,
    kind: "write",
    state: "committed",
    offset: 4,
    path: intent.path,
    write: { path: intent.path, size: 4, sha256: intent.sha256!, create: true },
  };
  expect(matchesArchivedIntent(intent, result)).toBe(true);
  expect(matchesArchivedIntent(intent, { ...result, root_revision: 2 })).toBe(
    false,
  );
  expect(
    matchesArchivedIntent(intent, { ...result, workspace_id: "different" }),
  ).toBe(false);
  expect(matchesArchivedIntent(intent, { ...result, path: "other.bin" })).toBe(
    false,
  );
  expect(
    matchesArchivedIntent(intent, {
      ...result,
      write: { ...result.write!, sha256: "b".repeat(64) },
    }),
  ).toBe(false);
  expect(
    matchesArchivedIntent(
      { ...intent, kind: "rename", source: "old.bin" },
      { ...result, kind: "entry.rename", source: "another.bin" },
    ),
  ).toBe(false);
  expect(
    matchesArchivedIntent(
      { ...intent, kind: "delete", recursive: true },
      { ...result, kind: "entry.delete", recursive: false },
    ),
  ).toBe(false);
});
