import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  FileClient,
  FileServiceError,
  getWorkspace,
  initializeWorkspace,
  UncertainSaveError,
} from "../../services/files/client";
import {
  loadDraft,
  saveDraft,
  type Draft,
  type DraftIdentity,
} from "../../services/files/drafts";
import type {
  FileEntry,
  SaveTransaction,
  Workspace,
} from "../../services/files/types";
import type { TerminalRecord } from "../../types";

type Directory = { entries: FileEntry[]; truncated: boolean };
export type Document = {
  identity: DraftIdentity;
  path: string;
  base: string;
  text: string;
  version: string;
  sequence: number;
  encoding: "utf8" | "utf8-bom";
  newline: "lf" | "crlf";
  token: string | null;
  pending?: SaveTransaction;
  saving: boolean;
  conflict: boolean;
  warning: string;
  message: string;
  persistenceError: string;
};
const documentKey = (id: DraftIdentity) =>
  JSON.stringify([
    id.account,
    id.nodeID,
    id.workspaceID,
    id.rootRevision,
    id.path,
  ]);
const childPath = (parent: string, name: string) =>
  parent === "." ? name : `${parent}/${name}`;

export function useWorkspace(
  enabled: boolean,
  terminal: TerminalRecord | undefined,
  account: string,
) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [connection, setConnection] = useState("等待连接");
  const [error, setError] = useState("");
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [selected, setSelected] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(0);
  const clientRef = useRef<FileClient | null>(null),
    generation = useRef(0);
  const docs = useRef(new Map<string, Document>()),
    selections = useRef(new Map<string, string>()),
    timers = useRef(new Map<string, number>()),
    queues = useRef(new Map<string, Promise<void>>());
  const [, render] = useReducer((n: number) => n + 1, 0);
  const update = useCallback(() => render(), []);

  const persist = useCallback(
    (doc: Document): Promise<void> => {
      const id = documentKey(doc.identity);
      const previous = queues.current.get(id) || Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          const draft: Draft = {
            identity: doc.identity,
            baseVersion: doc.version,
            baseText: doc.base,
            text: doc.text,
            sequence: doc.sequence,
            encoding: doc.encoding,
            newline: doc.newline,
            pendingSave: doc.pending,
          };
          try {
            const stored = await saveDraft(draft, doc.token);
            doc.token = stored.token;
            doc.persistenceError = "";
          } catch (e) {
            doc.persistenceError = (e as Error).message;
            throw e;
          } finally {
            update();
          }
        });
      queues.current.set(id, next);
      void next
        .finally(() => {
          if (queues.current.get(id) === next) queues.current.delete(id);
        })
        .catch(() => {});
      return next;
    },
    [update],
  );
  const schedule = useCallback(
    (doc: Document) => {
      const id = documentKey(doc.identity),
        old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          void persist(doc).catch(() => {});
        }, 400),
      );
    },
    [persist],
  );
  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of timers.current) {
        clearTimeout(timer);
        timers.current.delete(id);
        const doc = docs.current.get(id);
        if (doc) void persist(doc).catch(() => {});
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persist]);

  const loadDirectory = useCallback(
    async (client: FileClient, path: string, gen: number) => {
      let snapshot = "",
        offset = 0,
        truncated = false;
      const entries: FileEntry[] = [];
      do {
        const page = await client.list(path, false, "", snapshot, offset);
        entries.push(...page.entries);
        truncated = page.truncated;
        snapshot = page.snapshot;
        offset = page.next;
        if (!page.has_more) break;
      } while (entries.length < 20000);
      if (gen === generation.current)
        setDirectories((previous) => ({
          ...previous,
          [path]: { entries, truncated },
        }));
    },
    [],
  );
  useEffect(() => {
    const gen = ++generation.current;
    let stopped = false,
      client: FileClient | undefined,
      retry = 0;
    setWorkspace(null);
    setDirectories({});
    setExpanded(new Set(["."]));
    setSelected(null);
    setError("");
    if (!enabled || !terminal || !account) {
      setConnection("未连接");
      return;
    }
    const run = async () => {
      setConnection("连接中");
      try {
        let view = await getWorkspace(terminal.id);
        if (!view.initialized) view = await initializeWorkspace(terminal.id);
        if (view.state !== "ready" || !view.workspace)
          throw new Error("工作区正在恢复，请稍后重试");
        const connected = await FileClient.connect(view.workspace);
        if (stopped || gen !== generation.current) {
          connected.close();
          return;
        }
        client = connected;
        clientRef.current = connected;
        setWorkspace(view.workspace);
        setSelected(selections.current.get(view.workspace.id) || null);
        setConnection("中转连接");
        setError("");
        connected.onDisconnect(() => {
          if (!stopped && gen === generation.current) {
            clientRef.current = null;
            setConnection("连接已断开");
            setError("文件连接已断开，正在尝试恢复");
            retry = window.setTimeout(() => setReconnect((n) => n + 1), 3000);
          }
        });
        await loadDirectory(connected, ".", gen);
      } catch (e) {
        if (!stopped && gen === generation.current) {
          setError((e as Error).message);
          setConnection("连接失败");
          retry = window.setTimeout(() => setReconnect((n) => n + 1), 5000);
        }
      }
    };
    void run();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (clientRef.current === client) clientRef.current = null;
      client?.close();
    };
  }, [
    enabled,
    terminal?.id,
    terminal?.node_id,
    account,
    reconnect,
    loadDirectory,
  ]);

  const refresh = useCallback(async () => {
    const client = clientRef.current,
      gen = generation.current;
    if (!client) return;
    try {
      for (const path of expanded) await loadDirectory(client, path, gen);
      setError("");
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    }
  }, [expanded, loadDirectory]);
  useEffect(() => {
    if (!enabled || !workspace) return;
    const timer = window.setInterval(() => {
      if (globalThis.document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [enabled, workspace, refresh]);
  const toggle = useCallback(
    async (path: string) => {
      if (expanded.has(path)) {
        setExpanded((old) => {
          const next = new Set(old);
          next.delete(path);
          return next;
        });
        return;
      }
      const client = clientRef.current,
        gen = generation.current;
      if (!client) return;
      try {
        await loadDirectory(client, path, gen);
        if (gen !== generation.current) return;
        setExpanded((old) => new Set([...old, path]));
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      }
    },
    [expanded, loadDirectory],
  );
  const openFile = useCallback(
    async (path: string) => {
      const client = clientRef.current,
        w = workspace;
      if (!client || !w || !terminal) return;
      const gen = generation.current;
      const identity: DraftIdentity = {
        account,
        nodeID: terminal.node_id,
        workspaceID: w.id,
        rootRevision: w.root_revision,
        path,
      };
      const key = documentKey(identity);
      if (docs.current.has(key)) {
        selections.current.set(w.id, key);
        setSelected(key);
        return;
      }
      try {
        const { entry, bytes } = await client.readBytes(path);
        if (!entry.version) throw new Error("文件缺少版本信息");
        const bom =
          bytes.length >= 3 &&
          bytes[0] === 0xef &&
          bytes[1] === 0xbb &&
          bytes[2] === 0xbf;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0"))
          throw new Error("此文件不是可编辑的 UTF-8 文本");
        const crlf = (text.match(/\r\n/g) || []).length,
          bareLF = (text.match(/(?<!\r)\n/g) || []).length,
          bareCR = (text.match(/\r(?!\n)/g) || []).length;
        const warning =
          bareCR || (crlf && bareLF) ? "文件包含混合换行，暂不能安全保存" : "";
        let saved: Awaited<ReturnType<typeof loadDraft>> = undefined;
        let persistenceError = "";
        try {
          saved = await loadDraft(identity);
        } catch (e) {
          persistenceError = (e as Error).message;
        }
        if (saved?.pendingSave) {
          try {
            const operation = await client.operationStatus(
              saved.pendingSave.opID,
            );
            if (operation.state === "committed" && operation.version) {
              saved.baseText = new TextDecoder().decode(
                saved.pendingSave.content,
              );
              saved.baseVersion = operation.version;
              saved.pendingSave = undefined;
            }
          } catch {
            /* Keep the original operation for a later retry. */
          }
        }
        if (
          saved &&
          !saved.pendingSave &&
          saved.text === saved.baseText &&
          saved.baseVersion !== entry.version
        ) {
          saved.baseText = text;
          saved.text = text;
          saved.baseVersion = entry.version;
          saved.encoding = bom ? "utf8-bom" : "utf8";
          saved.newline = crlf ? "crlf" : "lf";
        }
        if (gen !== generation.current) return;
        const doc: Document = {
          identity,
          path,
          base: saved?.baseText ?? text,
          text: saved?.text ?? text,
          version: saved?.baseVersion ?? entry.version,
          sequence: saved?.sequence ?? 0,
          encoding: saved?.encoding ?? (bom ? "utf8-bom" : "utf8"),
          newline: saved?.newline ?? (crlf ? "crlf" : "lf"),
          token: saved?.token ?? null,
          pending: saved?.pendingSave,
          saving: false,
          conflict: !!saved && saved.baseVersion !== entry.version,
          warning,
          message: "",
          persistenceError,
        };
        docs.current.set(key, doc);
        selections.current.set(w.id, key);
        setSelected(key);
        update();
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      }
    },
    [workspace, terminal?.id, terminal?.node_id, account, update],
  );
  const selectedDocument = selected ? docs.current.get(selected) : undefined;
  const document =
    selectedDocument?.identity.workspaceID === workspace?.id &&
    selectedDocument?.identity.rootRevision === workspace?.root_revision &&
    selectedDocument?.identity.account === account
      ? selectedDocument
      : undefined;
  const edit = useCallback(
    (doc: Document, text: string) => {
      doc.text = text;
      doc.sequence++;
      schedule(doc);
      update();
    },
    [schedule, update],
  );
  const save = useCallback(
    async (doc: Document) => {
      const client = clientRef.current;
      if (
        !client ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision ||
        doc.saving ||
        doc.conflict ||
        doc.warning
      )
        return;
      doc.saving = true;
      doc.message = "";
      update();
      try {
        let transaction = doc.pending;
        if (!transaction) {
          const text = doc.text;
          let encoded = new TextEncoder().encode(text);
          if (doc.encoding === "utf8-bom") {
            const b = new Uint8Array(encoded.length + 3);
            b.set([0xef, 0xbb, 0xbf]);
            b.set(encoded, 3);
            encoded = b;
          }
          transaction = await client.prepareSave(
            doc.path,
            encoded,
            doc.version,
            false,
          );
          doc.pending = transaction;
        }
        await persist(doc); // persist operation ID and its exact snapshot before sending
        const result = await client.save(transaction);
        if (!result.version) throw new Error("节点未返回文件版本");
        let savedText = new TextDecoder().decode(transaction.content); // TextDecoder removes an optional UTF-8 BOM
        doc.base = savedText;
        doc.version = result.version;
        doc.pending = undefined;
        doc.conflict = false;
        await persist(doc);
        void refresh();
      } catch (e) {
        if (e instanceof UncertainSaveError) doc.pending = e.transaction;
        if (e instanceof FileServiceError && e.code === "CONFLICT")
          doc.conflict = true;
        doc.message = (e as Error).message;
        await persist(doc).catch(() => {});
      } finally {
        doc.saving = false;
        update();
      }
    },
    [persist, refresh, update],
  );
  const retry = useCallback(() => setReconnect((n) => n + 1), []);
  return {
    workspace,
    connection,
    error,
    directories,
    expanded,
    selected,
    document,
    documents: Array.from(docs.current.entries()).filter(
      ([, d]) =>
        d.identity.workspaceID === workspace?.id &&
        d.identity.rootRevision === workspace?.root_revision &&
        d.identity.account === account,
    ),
    refresh,
    toggle,
    openFile,
    edit,
    save,
    retry,
    select: (id: string) => {
      if (workspace) selections.current.set(workspace.id, id);
      setSelected(id);
    },
    childPath,
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
