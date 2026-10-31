import type { PendingWrite, Workspace } from "./types";

// Store only operation metadata. Independent records and IDB transactions keep
// another tab's recovery record from being overwritten or removed accidentally.
const scopeKey = (w: Workspace) => JSON.stringify([w.id, w.root_revision]);
const itemKey = (w: Workspace, id: string) =>
  JSON.stringify([w.id, w.root_revision, id]);
type Stored = { key: string; scope: string; raw: string };

function validate(value: unknown, w: Workspace): PendingWrite {
  const v = value as PendingWrite;
  if (
    !v ||
    !/^[0-9a-f]{48}$/.test(v.id) ||
    v.workspace_id !== w.id ||
    v.root_revision !== w.root_revision ||
    v.kind !== "write" ||
    !["receiving", "ready"].includes(v.state) ||
    typeof v.path !== "string" ||
    !v.path ||
    new TextEncoder().encode(v.path).length > 4096 ||
    !Number.isSafeInteger(v.offset) ||
    v.offset < 0 ||
    !Number.isSafeInteger(v.size) ||
    v.size < v.offset ||
    typeof v.create !== "boolean" ||
    !Number.isSafeInteger(v.updated_at) ||
    v.updated_at < 1
  )
    throw new Error("浏览器中的取消记录无效，请勿重复操作并人工核对文件。");
  return v;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("workdeck-pending-cancels", 1);
    let rejected = false;
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("records", { keyPath: "key" });
      store.createIndex("scope", "scope");
    };
    req.onsuccess = () => {
      if (rejected) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => {
      rejected = true;
      reject(req.error || new Error("无法打开取消记录"));
    };
    req.onblocked = () => {
      rejected = true;
      reject(new Error("取消记录被其他标签页阻塞"));
    };
  });
}
export async function listPendingCancels(
  w: Workspace,
): Promise<PendingWrite[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readonly"),
        req = tx.objectStore("records").getAll(undefined, 1001);
      req.onsuccess = () => {
        try {
          const rows = req.result as Stored[];
          if (rows.length > 1000)
            throw new Error("浏览器取消记录超过 1000 条，请先逐项核对。");
          const items: PendingWrite[] = [];
          for (const row of rows) {
            const scope = JSON.parse(row.scope);
            if (!Array.isArray(scope) || scope.length !== 2)
              throw new Error("取消记录范围无效。");
            if (scope[0] !== w.id) continue;
            if (!Number.isSafeInteger(scope[1]) || scope[1] < 1)
              throw new Error("取消记录修订无效。");
            if (scope[1] > w.root_revision) continue;
            const source = { ...w, root_revision: scope[1] };
            const item = validate(JSON.parse(row.raw), source);
            if (row.key !== itemKey(source, item.id))
              throw new Error("取消记录标识不匹配。");
            items.push(item);
          }
          resolve(items);
        } catch (e) {
          reject(e);
        }
      };
      req.onerror = () => reject(req.error || new Error("无法读取取消记录"));
    });
  } finally {
    db.close();
  }
}
export async function rememberPendingCancel(
  w: Workspace,
  item: PendingWrite,
): Promise<void> {
  validate(item, w);
  const db = await open(),
    key = itemKey(w, item.id),
    scope = scopeKey(w),
    raw = JSON.stringify(item);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records"),
        get = store.get(key);
      let reason = "";
      get.onsuccess = () => {
        if (get.result) {
          reason = "此操作已有待核对的取消记录，请先核对结果。";
          tx.abort();
          return;
        }
        const count = store.index("scope").count(IDBKeyRange.only(scope));
        count.onsuccess = () => {
          if (count.result >= 100) {
            reason = "待核对的取消记录过多，请先逐项核对。";
            tx.abort();
            return;
          }
          store.add({ key, scope, raw });
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(new Error(reason || tx.error?.message || "无法保存取消记录"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
export async function forgetPendingCancel(
  w: Workspace,
  item: PendingWrite,
): Promise<void> {
  validate(item, w);
  const db = await open(),
    key = itemKey(w, item.id),
    raw = JSON.stringify(item);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records"),
        get = store.get(key);
      let reason = "";
      get.onsuccess = () => {
        if (!get.result) return;
        if ((get.result as Stored).raw !== raw) {
          reason = "取消记录已在其他标签页改变，请重新核对。";
          tx.abort();
          return;
        }
        store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(new Error(reason || tx.error?.message || "无法移除取消记录"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
