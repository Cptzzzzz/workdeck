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
  STORE = "drafts",
  INTENTS = "file-intents";
export type CreateIntent = {
  account: string;
  nodeID: string;
  workspaceID: string;
  rootRevision: number;
  opID: string;
  kind: "file" | "directory" | "upload";
  path: string;
  createdAt: number;
  size?: number;
  sha256?: string;
  sourceName?: string;
};
const intentScope = (
  v: Pick<CreateIntent, "account" | "nodeID" | "workspaceID" | "rootRevision">,
) => JSON.stringify([v.account, v.nodeID, v.workspaceID, v.rootRevision]);
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
    const request = indexedDB.open(DATABASE, 2);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(INTENTS)) {
        const store = request.result.createObjectStore(INTENTS, {
          keyPath: "opID",
        });
        store.createIndex("scope", "scope");
        store.createIndex("target", "target", { unique: true });
      }
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

export async function recordCreateIntent(intent: CreateIntent): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INTENTS, "readwrite");
      const scope = intentScope(intent);
      const store = tx.objectStore(INTENTS);
      const count = store.index("scope").count(IDBKeyRange.only(scope));
      let quota = false;
      count.onsuccess = () => {
        if (count.result >= 100) {
          quota = true;
          tx.abort();
          return;
        }
        store.add({
          ...intent,
          scope,
          target: JSON.stringify([scope, intent.path]),
        });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          quota
            ? new Error("待确认的创建操作已达上限，请先核对")
            : tx.error?.name === "ConstraintError"
              ? new Error("该路径已有待确认的创建操作，请先核对")
              : tx.error || new Error("无法保存文件操作记录"),
        );
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
export async function listCreateIntents(
  scope: Pick<
    CreateIntent,
    "account" | "nodeID" | "workspaceID" | "rootRevision"
  >,
): Promise<CreateIntent[]> {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(INTENTS, "readonly"),
        request = tx
          .objectStore(INTENTS)
          .index("scope")
          .getAll(IDBKeyRange.only(intentScope(scope)), 100);
      request.onsuccess = () => resolve(request.result as CreateIntent[]);
      request.onerror = () =>
        reject(request.error || new Error("读取文件操作记录失败"));
      tx.onabort = () => reject(tx.error || new Error("读取文件操作记录失败"));
    });
  } finally {
    db.close();
  }
}
export async function removeCreateIntent(opID: string): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INTENTS, "readwrite");
      tx.objectStore(INTENTS).delete(opID);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("清理文件操作记录失败"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
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

export type DraftMove = {
  previous: DraftIdentity;
  identity: DraftIdentity;
  previousToken: string;
  token: string;
};

// The caller must flush and freeze its live editors before a rename, and keep
// the rename intent until this transaction has committed. Other tabs retain
// their old token and therefore cannot recreate the moved record silently.
export async function moveDrafts(
  scope: Omit<DraftIdentity, "path">,
  source: string,
  target: string,
): Promise<DraftMove[]> {
  const parent = (path: string) => {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
  };
  const valid = (path: string) =>
    !!path &&
    path !== "." &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !path.includes("\0");
  if (
    !valid(source) ||
    !valid(target) ||
    source === target ||
    parent(source) !== parent(target)
  )
    throw new Error("草稿迁移路径无效");
  const db = await openDB();
  try {
    return await new Promise<DraftMove[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"),
        store = tx.objectStore(STORE);
      const moves: DraftMove[] = [];
      let problem = "";
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        const draft = item.value as StoredDraft;
        const id = draft?.identity;
        const inScope =
          id &&
          id.account === scope.account &&
          id.nodeID === scope.nodeID &&
          id.workspaceID === scope.workspaceID &&
          id.rootRevision === scope.rootRevision;
        if (
          inScope &&
          typeof id.path === "string" &&
          (id.path === source || id.path.startsWith(source + "/"))
        ) {
          if (
            draft.pendingSave ||
            typeof draft.token !== "string" ||
            item.primaryKey !== key(id)
          ) {
            problem = "草稿存在待确认保存或数据异常，请先核对";
            tx.abort();
            return;
          }
          if (moves.length >= 256) {
            problem = "待迁移草稿过多，请先处理部分草稿";
            tx.abort();
            return;
          }
          const next = { ...id, path: target + id.path.slice(source.length) },
            nextKey = key(next);
          const token = crypto.randomUUID(),
            previousKey = item.primaryKey;
          moves.push({
            previous: id,
            identity: next,
            previousToken: draft.token,
            token,
          });
          const check = store.get(nextKey);
          check.onsuccess = () => {
            if (check.result !== undefined) {
              problem = "目标路径已有草稿，请先处理后重试";
              tx.abort();
              return;
            }
            store.put(
              { ...draft, identity: next, token, updatedAt: Date.now() },
              nextKey,
            );
            store.delete(previousKey);
          };
        }
        item.continue();
      };
      tx.oncomplete = () => resolve(moves);
      tx.onabort = () =>
        reject(
          problem
            ? new Error(problem)
            : tx.error || new Error("草稿路径迁移失败"),
        );
      tx.onerror = () => {};
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
