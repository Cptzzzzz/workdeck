type Rows = { keys: IDBValidKey[]; values: unknown[] };
type DatabaseRecords = { name: string; stores: Record<string, Rows> };
type BridgeMessage = {
  type: string;
  nonce: string;
  status: string;
  ticket?: string;
  username?: string;
  settings?: Record<string, string>;
  databases?: DatabaseRecords[];
  message?: string;
};
const known = new Set([
  "workdeck-workspace-drafts",
  "workdeck-workspace-views",
  "workdeck-pending-cancels",
]);

function openDatabase(name: string): Promise<IDBDatabase> {
  const version = name === "workdeck-workspace-drafts" ? 2 : 1;
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (name === "workdeck-workspace-drafts") {
        if (!db.objectStoreNames.contains("drafts"))
          db.createObjectStore("drafts");
        if (!db.objectStoreNames.contains("file-intents")) {
          const s = db.createObjectStore("file-intents", { keyPath: "opID" });
          s.createIndex("scope", "scope");
          s.createIndex("target", "target", { unique: true });
        }
      } else if (name === "workdeck-workspace-views") {
        if (!db.objectStoreNames.contains("pdf-views"))
          db.createObjectStore("pdf-views");
      } else if (name === "workdeck-pending-cancels") {
        if (!db.objectStoreNames.contains("records")) {
          const s = db.createObjectStore("records", { keyPath: "key" });
          s.createIndex("scope", "scope");
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("无法打开本地工作区存储"));
    r.onblocked = () => reject(new Error("本地工作区存储被其他标签页阻塞"));
  });
}

async function importRecords(data: DatabaseRecords[]): Promise<void> {
  for (const record of data) {
    if (!known.has(record.name)) throw new Error("迁移存储类型无效");
    const db = await openDatabase(record.name);
    try {
      const stores = Object.keys(record.stores);
      if (!stores.every((name) => db.objectStoreNames.contains(name)))
        throw new Error("工作区存储版本不匹配");
      if (!stores.length) continue;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        let conflict = false;
        for (const name of stores) {
          const rows = record.stores[name];
          if (
            !Array.isArray(rows.keys) ||
            !Array.isArray(rows.values) ||
            rows.keys.length !== rows.values.length
          ) {
            conflict = true;
            tx.abort();
            break;
          }
          const store = tx.objectStore(name);
          rows.keys.forEach((key, i) => {
            const get = store.get(key);
            get.onsuccess = () => {
              if (get.result !== undefined) {
                if (
                  JSON.stringify(get.result) !== JSON.stringify(rows.values[i])
                ) {
                  conflict = true;
                  tx.abort();
                }
              } else if (store.keyPath === null) store.add(rows.values[i], key);
              else store.add(rows.values[i]);
            };
          });
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(
            new Error(
              conflict
                ? "新旧站点存在不同的本地草稿，请保留旧站点数据并人工核对"
                : "导入本地工作区数据失败",
            ),
          );
        tx.onerror = () => {};
      });
    } finally {
      db.close();
    }
  }
}

// Wait for the old-origin frame only during the first migration. Failures
// leave the source untouched and are retried on the next page load.
export async function migrateBrowserState(): Promise<string | null> {
  let frame: HTMLIFrameElement | undefined;
  try {
    const res = await fetch("/api/migration/config", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const config = (await res.json()) as {
      legacyOrigin: string;
      publicOrigin: string;
    };
    if (
      config.publicOrigin !== location.origin ||
      !config.legacyOrigin.startsWith("https://")
    )
      return null;
    const marker = "workdeck.migrated-from." + config.legacyOrigin;
    if (localStorage.getItem(marker) === "done") return null;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const nonce = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    frame = document.createElement("iframe");
    frame.hidden = true;
    frame.sandbox.add("allow-scripts", "allow-same-origin");
    const data = await new Promise<BridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("原站点迁移连接超时"));
      }, 8000);
      const handler = (event: MessageEvent<BridgeMessage>) => {
        if (
          event.origin !== config.legacyOrigin ||
          event.source !== frame?.contentWindow ||
          event.data?.type !== "workdeck-migration-v1" ||
          event.data.nonce !== nonce
        )
          return;
        cleanup();
        resolve(event.data);
      };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
      };
      window.addEventListener("message", handler);
      frame!.src = config.legacyOrigin + "/migration/frame#" + nonce;
      document.body.appendChild(frame!);
    });
    if (data.status === "not-logged-in")
      return "原站点未登录，原有浏览器草稿仍保留在旧站点；登录旧站点后刷新可尝试迁移。";
    if (
      data.status !== "ready" ||
      !data.ticket ||
      !data.username ||
      !Array.isArray(data.databases) ||
      !data.settings
    )
      throw new Error(data.message || "原站点迁移数据无效");
    const current = await fetch("/api/me", { credentials: "same-origin" });
    if (current.ok) {
      const user = (await current.json()) as { username: string };
      if (user.username !== data.username)
        throw new Error("新旧站点登录账户不同，未迁移本地草稿");
    } else {
      const redeem = await fetch("/api/migration/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: data.ticket }),
      });
      if (!redeem.ok) throw new Error("登录状态迁移失败，请重新登录");
    }
    await importRecords(data.databases);
    for (const [key, value] of Object.entries(data.settings))
      if (
        key.startsWith("workdeck") &&
        typeof value === "string" &&
        localStorage.getItem(key) === null
      )
        localStorage.setItem(key, value);
    localStorage.setItem(marker, "done");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "浏览器数据迁移失败";
  } finally {
    frame?.remove();
  }
}
