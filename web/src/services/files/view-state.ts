import type { DraftIdentity } from "./drafts";

export type PDFViewState = {
  page: number;
  zoom: number;
  scrollTop: number;
  scrollLeft: number;
};
export type EditorViewState = {
  line: number;
  column: number;
  scrollTop: number;
  scrollLeft: number;
};
export type WorkspaceViewScope = Omit<DraftIdentity, "path">;
export type WorkspaceTabs = { paths: string[]; selected: string | null };
const database = "workdeck-workspace-views",
  store = "pdf-views";
const queues = new Map<string, Promise<void>>();
function key(identity: DraftIdentity): string {
  return JSON.stringify([
    identity.account,
    identity.nodeID,
    identity.workspaceID,
    identity.rootRevision,
    identity.path,
  ]);
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(store))
        request.result.createObjectStore(store);
    };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      failed = true;
      reject(request.error || new Error("无法打开视图存储"));
    };
    request.onblocked = () => {
      failed = true;
      reject(new Error("视图存储被其他标签页阻塞"));
    };
  });
}
function valid(value: unknown): value is PDFViewState {
  const v = value as PDFViewState | null;
  return (
    !!v &&
    Number.isSafeInteger(v.page) &&
    v.page >= 1 &&
    v.page <= 100000 &&
    Number.isFinite(v.zoom) &&
    v.zoom >= 0.5 &&
    v.zoom <= 3 &&
    Number.isFinite(v.scrollTop) &&
    v.scrollTop >= 0 &&
    v.scrollTop <= 100000000 &&
    Number.isFinite(v.scrollLeft) &&
    v.scrollLeft >= 0 &&
    v.scrollLeft <= 100000000
  );
}
export async function readPDFView(
  identity: DraftIdentity,
): Promise<PDFViewState | undefined> {
  const id = key(identity);
  await queues.get(id)?.catch(() => {});
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"),
        request = tx.objectStore(store).get(id);
      request.onsuccess = () =>
        resolve(valid(request.result) ? request.result : undefined);
      request.onerror = () =>
        reject(request.error || new Error("读取 PDF 视图失败"));
      tx.onabort = () => reject(tx.error || new Error("读取 PDF 视图失败"));
    });
  } finally {
    db.close();
  }
}
export function writePDFView(
  identity: DraftIdentity,
  value: PDFViewState,
): Promise<void> {
  if (!valid(value)) return Promise.reject(new Error("PDF 视图参数无效"));
  const id = key(identity),
    snapshot = { ...value };
  const prior = queues.get(id) || Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(snapshot, id);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error("保存 PDF 视图失败"));
          tx.onerror = () => {};
        });
      } finally {
        db.close();
      }
    });
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => {});
  return next;
}

function validEditor(value: unknown): value is EditorViewState {
  const v = value as EditorViewState | null;
  return (
    !!v &&
    Number.isSafeInteger(v.line) &&
    v.line >= 1 &&
    v.line <= 10000000 &&
    Number.isSafeInteger(v.column) &&
    v.column >= 1 &&
    v.column <= 10000000 &&
    Number.isFinite(v.scrollTop) &&
    v.scrollTop >= 0 &&
    v.scrollTop <= 100000000 &&
    Number.isFinite(v.scrollLeft) &&
    v.scrollLeft >= 0 &&
    v.scrollLeft <= 100000000
  );
}

export async function readEditorView(
  identity: DraftIdentity,
): Promise<EditorViewState | undefined> {
  const id = "editor:" + key(identity);
  try {
    const session = sessionStorage.getItem("workdeck-view:" + id);
    if (session) {
      const value: unknown = JSON.parse(session);
      if (validEditor(value)) return value;
    }
  } catch {
    // IndexedDB remains the fallback if session storage is unavailable.
  }
  await queues.get(id)?.catch(() => {});
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"),
        request = tx.objectStore(store).get(id);
      request.onsuccess = () =>
        resolve(validEditor(request.result) ? request.result : undefined);
      request.onerror = () =>
        reject(request.error || new Error("读取编辑器视图失败"));
      tx.onabort = () => reject(tx.error || new Error("读取编辑器视图失败"));
    });
  } finally {
    db.close();
  }
}

export function writeEditorView(
  identity: DraftIdentity,
  value: EditorViewState,
): Promise<void> {
  if (!validEditor(value))
    return Promise.reject(new Error("编辑器视图参数无效"));
  const id = "editor:" + key(identity),
    snapshot = { ...value };
  try {
    sessionStorage.setItem("workdeck-view:" + id, JSON.stringify(snapshot));
  } catch {
    // Continue with IndexedDB; it reports an error if persistence also fails.
  }
  const prior = queues.get(id) || Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(snapshot, id);
          tx.oncomplete = () => resolve();
          tx.onabort = () =>
            reject(tx.error || new Error("保存编辑器视图失败"));
          tx.onerror = () => {};
        });
      } finally {
        db.close();
      }
    });
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => {});
  return next;
}

function tabsKey(scope: WorkspaceViewScope): string {
  return (
    "tabs:" +
    JSON.stringify([
      scope.account,
      scope.nodeID,
      scope.workspaceID,
      scope.rootRevision,
    ])
  );
}
function validTabs(value: unknown): value is WorkspaceTabs {
  const v = value as WorkspaceTabs | null;
  const validPath = (p: unknown) =>
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !p.includes("\0") &&
    !p.startsWith("/") &&
    p.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  return (
    !!v &&
    Array.isArray(v.paths) &&
    v.paths.length <= 1000 &&
    v.paths.every(validPath) &&
    new Set(v.paths).size === v.paths.length &&
    (v.selected === null ||
      (validPath(v.selected) && v.paths.includes(v.selected)))
  );
}
export async function readWorkspaceTabs(
  scope: WorkspaceViewScope,
): Promise<WorkspaceTabs | undefined> {
  const id = tabsKey(scope);
  try {
    const session = sessionStorage.getItem("workdeck-view:" + id);
    if (session) {
      const value: unknown = JSON.parse(session);
      if (validTabs(value)) return value;
    }
  } catch {
    /* IndexedDB remains the fallback. */
  }
  await queues.get(id)?.catch(() => {});
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"),
        request = tx.objectStore(store).get(id);
      request.onsuccess = () =>
        resolve(validTabs(request.result) ? request.result : undefined);
      request.onerror = () =>
        reject(request.error || new Error("读取文件标签失败"));
      tx.onabort = () => reject(tx.error || new Error("读取文件标签失败"));
    });
  } finally {
    db.close();
  }
}
export function writeWorkspaceTabs(
  scope: WorkspaceViewScope,
  value: WorkspaceTabs,
): Promise<void> {
  if (!validTabs(value))
    return Promise.reject(new Error("文件标签状态无效或数量超过限制"));
  const id = tabsKey(scope),
    snapshot = { paths: [...value.paths], selected: value.selected };
  try {
    sessionStorage.setItem("workdeck-view:" + id, JSON.stringify(snapshot));
  } catch {
    /* IndexedDB remains the fallback. */
  }
  const prior = queues.get(id) || Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(snapshot, id);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error("保存文件标签失败"));
          tx.onerror = () => {};
        });
      } finally {
        db.close();
      }
    });
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => {});
  return next;
}
