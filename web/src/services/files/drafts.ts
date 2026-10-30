import type { SaveTransaction } from "./types";

export type DraftIdentity = {
  account: string;
  nodeID: string;
  workspaceID: string;
  rootRevision: number;
  path: string;
};
export type Draft = {
  identity: DraftIdentity;
  baseVersion: string;
  baseText: string;
  text: string;
  sequence: number;
  encoding: "utf8" | "utf8-bom";
  newline: "lf" | "crlf";
  pendingSave?: SaveTransaction;
};
export type StoredDraft = Draft & { token: string; updatedAt: number };
export class DraftConflictError extends Error {
  constructor() {
    super("此草稿已在另一个标签页更改，请导出当前内容并重新打开草稿");
    this.name = "DraftConflictError";
  }
}

const DATABASE = "workdeck-workspace-drafts",
  STORE = "drafts";
function key(identity: DraftIdentity): string {
  return JSON.stringify([
    identity.account,
    identity.nodeID,
    identity.workspaceID,
    identity.rootRevision,
    identity.path,
  ]);
}
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (rejected) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      rejected = true;
      reject(request.error || new Error("无法打开浏览器草稿存储"));
    };
    request.onblocked = () => {
      rejected = true;
      reject(new Error("浏览器草稿存储被其他标签页阻塞"));
    };
  });
}
export async function loadDraft(
  identity: DraftIdentity,
): Promise<StoredDraft | undefined> {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly"),
        request = transaction.objectStore(STORE).get(key(identity));
      request.onsuccess = () =>
        resolve(request.result as StoredDraft | undefined);
      request.onerror = () =>
        reject(request.error || new Error("读取草稿失败"));
      transaction.onabort = () =>
        reject(transaction.error || new Error("读取草稿失败"));
    });
  } finally {
    db.close();
  }
}
// Compare-and-swap prevents a second tab or a delayed write from silently
// overwriting a newer draft. The caller must retain the returned token.
export async function saveDraft(
  draft: Draft,
  expectedToken: string | null,
): Promise<StoredDraft> {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite"),
        store = transaction.objectStore(STORE),
        request = store.get(key(draft.identity));
      let result: StoredDraft | undefined,
        conflict = false;
      request.onsuccess = () => {
        const previous = request.result as StoredDraft | undefined;
        if ((previous?.token || null) !== expectedToken) {
          conflict = true;
          transaction.abort();
          return;
        }
        result = {
          ...draft,
          token: crypto.randomUUID(),
          updatedAt: Date.now(),
        };
        store.put(result, key(draft.identity));
      };
      transaction.oncomplete = () => resolve(result!);
      transaction.onabort = () =>
        reject(
          conflict
            ? new DraftConflictError()
            : transaction.error || new Error("保存浏览器草稿失败"),
        );
      transaction.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
export async function deleteDraft(
  identity: DraftIdentity,
  expectedToken: string,
): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite"),
        store = transaction.objectStore(STORE),
        request = store.get(key(identity));
      let conflict = false;
      request.onsuccess = () => {
        const previous = request.result as StoredDraft | undefined;
        if (previous && previous.token !== expectedToken) {
          conflict = true;
          transaction.abort();
          return;
        }
        if (previous) store.delete(key(identity));
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          conflict
            ? new DraftConflictError()
            : transaction.error || new Error("删除浏览器草稿失败"),
        );
      transaction.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
