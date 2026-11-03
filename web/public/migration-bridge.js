/* Temporary old-origin bridge. Records are sent directly to the configured
 * new-origin parent; the server never receives browser drafts. */
(async () => {
  const nonce = location.hash.slice(1);
  if (window.parent === window || !/^[0-9a-f]{48}$/.test(nonce)) return;
  const config = await fetch("/api/migration/config", {
    credentials: "same-origin",
  }).then((r) => r.json());
  if (location.origin !== config.legacyOrigin || !config.publicOrigin) return;
  const send = (data) =>
    window.parent.postMessage(
      { type: "workdeck-migration-v1", nonce, ...data },
      config.publicOrigin,
    );
  try {
    const issue = await fetch("/api/migration/issue", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!issue.ok && issue.status !== 401)
      throw new Error("无法验证原站点登录");
    const auth = issue.ok ? await issue.json() : null;
    const settings = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        key.startsWith("workdeck") &&
        !key.startsWith("workdeck.migrated-from.")
      )
        settings[key] = localStorage.getItem(key);
    }
    const names = [
      "workdeck-workspace-drafts",
      "workdeck-workspace-views",
      "workdeck-pending-cancels",
    ];
    const databases = [];
    for (const name of names) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        let missing = false;
        req.onupgradeneeded = () => {
          missing = true;
          req.transaction.abort();
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => (missing ? resolve(null) : reject(req.error));
        req.onblocked = () =>
          reject(new Error("原站点浏览器存储被其他标签页阻塞"));
      });
      if (!db) continue;
      try {
        const stores = Array.from(db.objectStoreNames),
          rows = {};
        if (stores.length)
          await new Promise((resolve, reject) => {
            const tx = db.transaction(stores, "readonly");
            for (const name of stores) {
              const store = tx.objectStore(name),
                keys = store.getAllKeys(),
                values = store.getAll();
              rows[name] = { keys: [], values: [] };
              keys.onsuccess = () => {
                rows[name].keys = keys.result;
              };
              values.onsuccess = () => {
                rows[name].values = values.result;
              };
            }
            tx.oncomplete = () => resolve();
            tx.onabort = () =>
              reject(tx.error || new Error("原站点存储读取失败"));
            tx.onerror = () => {};
          });
        databases.push({ name, stores: rows });
      } finally {
        db.close();
      }
    }
    if (!auth) {
      const hasData =
        Object.keys(settings).length > 0 ||
        databases.some((db) =>
          Object.values(db.stores).some((rows) => rows.keys.length > 0),
        );
      send({ status: "not-logged-in", hasData });
      return;
    }
    send({
      status: "ready",
      ticket: auth.ticket,
      username: auth.username,
      settings,
      databases,
    });
  } catch (error) {
    send({
      status: "error",
      message: error instanceof Error ? error.message : "迁移数据读取失败",
    });
  }
})().catch(() => {});
