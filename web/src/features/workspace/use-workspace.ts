import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  FileClient,
  FileServiceError,
  type FileTransportMetrics,
  getWorkspace,
  initializeWorkspace,
  changeWorkspaceRoot,
  UncertainSaveError,
} from "../../services/files/client";
import {
  loadDraft,
  deleteDraft,
  saveDraft,
  type Draft,
  type DraftIdentity,
  type CreateIntent,
  recordCreateIntent,
  listCreateIntents,
  removeCreateIntent,
  moveDrafts,
  confirmDeleteIntent,
  checkDeleteDrafts,
  markDeletedDrafts,
  listDeletedDrafts,
  listRecoverableDrafts,
  listArchivedDrafts,
  listArchivedIntents,
  removeArchivedIntent,
} from "../../services/files/drafts";
import type {
  FileEntry,
  SaveTransaction,
  UploadTransaction,
  Workspace,
  DeleteStatus,
  DeleteOutcome,
  ArchivedOperation,
} from "../../services/files/types";
import type { TerminalRecord } from "../../types";
import { downloadFile } from "../../services/files/download";
import { previewKind } from "./preview-utils";
import { matchesArchivedIntent } from "../../services/files/archive";
import {
  readWorkspaceTabs,
  writeWorkspaceTabs,
  type WorkspaceViewScope,
  type WorkspaceTabs,
} from "../../services/files/view-state";

type Directory = { entries: FileEntry[]; truncated: boolean; filter: string };
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
  pendingState?: string;
  saving: boolean;
  conflict: boolean;
  warning: string;
  message: string;
  persistenceError: string;
  deleted?: boolean;
  unavailable?: boolean;
  manualSaveRequired?: boolean;
  closing?: boolean;
};
export type BinaryPreview = {
  identity: DraftIdentity;
  path: string;
  kind: "image" | "pdf" | "large-text";
  version: string;
  size: number;
};
export type ConflictSnapshot = { text: string; version: string; key: string };
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
  autoSave: boolean,
  supportsCreate: boolean,
  supportsRename: boolean,
  supportsDelete: boolean,
  supportsWatch: boolean,
  supportsArchive: boolean,
) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [connection, setConnection] = useState("等待连接");
  const [fileMetrics, setFileMetrics] = useState<FileTransportMetrics | null>(
    null,
  );
  const [error, setError] = useState("");
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [directoryFilters, setDirectoryFilters] = useState<Map<string, string>>(
    new Map(),
  );
  const directoryFilterRef = useRef(new Map<string, string>());
  const directoryRequests = useRef(new Map<string, number>());
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem("workdeck.showHiddenFiles") === "true";
    } catch {
      return false;
    }
  });
  const showHiddenRef = useRef(showHidden);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState(".");
  const [intents, setIntents] = useState<CreateIntent[]>([]);
  const [deletedDrafts, setDeletedDrafts] = useState<DraftIdentity[]>([]);
  const [recoverableDrafts, setRecoverableDrafts] = useState<DraftIdentity[]>(
    [],
  );
  const [archivedRecords, setArchivedRecords] = useState<
    { identity: DraftIdentity; pending: boolean }[]
  >([]);
  const [archivedIntents, setArchivedIntents] = useState<CreateIntent[]>([]);
  const [archivedIntentsTruncated, setArchivedIntentsTruncated] =
    useState(false);
  const [transfer, setTransfer] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const clientRef = useRef<FileClient | null>(null),
    generation = useRef(0);
  const connectedScope = useRef<{
    scope: string;
    workspaceID?: string;
    revision?: number;
  } | null>(null);
  const docs = useRef(new Map<string, Document>()),
    previews = useRef(new Map<string, BinaryPreview>()),
    selections = useRef(new Map<string, string>()),
    timers = useRef(new Map<string, number>()),
    queues = useRef(new Map<string, Promise<void>>());
  const activeIntents = useRef(new Set<string>());
  const transferAbort = useRef<AbortController | null>(null);
  const renameLock = useRef(false);
  const creatingItems = useRef(0);
  const tabInteraction = useRef(0);
  const restoringTabs = useRef<{ scope: string; closed: Set<string> } | null>(
    null,
  );
  const [tabsReady, setTabsReady] = useState("");
  const lastTabs = useRef("");
  const [unrestoredTabs, setUnrestoredTabs] = useState<string[]>([]);
  const pendingTabs = useRef<{
    scope: string;
    paths: string[];
    selected: string | null;
    interaction: number;
  } | null>(null);
  const [revision, render] = useReducer((n: number) => n + 1, 0);
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
            deleted: doc.deleted,
            unavailable: doc.unavailable,
            manualSaveRequired: doc.manualSaveRequired,
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
      const filter = directoryFilterRef.current.get(path) || "";
      const hidden = showHiddenRef.current;
      const request = (directoryRequests.current.get(path) || 0) + 1;
      directoryRequests.current.set(path, request);
      let snapshot = "",
        offset = 0,
        truncated = false;
      const entries: FileEntry[] = [];
      do {
        const page = await client.list(path, hidden, filter, snapshot, offset);
        entries.push(...page.entries);
        truncated = page.truncated;
        snapshot = page.snapshot;
        offset = page.next;
        if (!page.has_more) break;
      } while (entries.length < 20000);
      if (
        gen === generation.current &&
        directoryRequests.current.get(path) === request
      )
        setDirectories((previous) => ({
          ...previous,
          [path]: { entries, truncated, filter },
        }));
    },
    [],
  );
  const filterDirectory = useCallback(
    async (path: string, filter: string) => {
      const client = clientRef.current,
        gen = generation.current;
      if (!client || renameLock.current) return;
      directoryFilterRef.current = new Map(directoryFilterRef.current).set(
        path,
        filter,
      );
      setDirectoryFilters(directoryFilterRef.current);
      try {
        await loadDirectory(client, path, gen);
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      }
    },
    [loadDirectory],
  );
  const changeShowHidden = useCallback(
    async (show: boolean) => {
      if (renameLock.current) return;
      showHiddenRef.current = show;
      setShowHidden(show);
      try {
        localStorage.setItem("workdeck.showHiddenFiles", String(show));
      } catch {
        /* Storage can be unavailable. */
      }
      const isHiddenPath = (path: string) =>
        path !== "." && path.split("/").some((part) => part.startsWith("."));
      const paths = [...expanded].filter((path) => show || !isHiddenPath(path));
      if (!show) {
        setExpanded(new Set(paths));
        setSelectedDirectory((old) => (isHiddenPath(old) ? "." : old));
      }
      const client = clientRef.current,
        gen = generation.current;
      if (!client) return;
      try {
        for (const path of paths) await loadDirectory(client, path, gen);
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      }
    },
    [expanded, loadDirectory],
  );
  useEffect(() => {
    const gen = ++generation.current;
    let stopped = false,
      client: FileClient | undefined,
      retry = 0;
    const scheduleRetry = (delay: number) => {
      if (retry) clearTimeout(retry);
      retry = window.setTimeout(() => setReconnect((n) => n + 1), delay);
    };
    const scope = JSON.stringify([account, terminal?.node_id, terminal?.id]);
    const resetView = () => {
      setWorkspace(null);
      setDirectories({});
      directoryFilterRef.current = new Map();
      directoryRequests.current = new Map();
      setDirectoryFilters(new Map());
      setExpanded(new Set(["."]));
      setSelected(null);
      setSelectedDirectory(".");
      setIntents([]);
      setDeletedDrafts([]);
      setRecoverableDrafts([]);
      setError("");
    };
    if (connectedScope.current?.scope !== scope) {
      resetView();
      connectedScope.current = { scope };
    }
    setFileMetrics(null);
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
          throw new Error(
            view.state === "changing" && view.pending_target
              ? `工作区目录正在恢复：${view.pending_target}，请稍后重试`
              : "工作区正在恢复，请稍后重试",
          );
        const connected = await FileClient.connect(view.workspace);
        if (stopped || gen !== generation.current) {
          connected.close();
          return;
        }
        const previous = connectedScope.current;
        if (
          previous?.scope === scope &&
          previous.workspaceID &&
          (previous.workspaceID !== view.workspace.id ||
            previous.revision !== view.workspace.root_revision)
        ) {
          selections.current.delete(previous.workspaceID);
          resetView();
        }
        connectedScope.current = {
          scope,
          workspaceID: view.workspace.id,
          revision: view.workspace.root_revision,
        };
        client = connected;
        clientRef.current = connected;
        setWorkspace(view.workspace);
        setSelected(selections.current.get(view.workspace.id) || null);
        setConnection("中转连接");
        connected.onRoute((route) => {
          if (!stopped && gen === generation.current)
            setConnection(route === "direct" ? "WebRTC 直连" : "中转连接");
        });
        connected.onMetrics((metrics) => {
          if (!stopped && gen === generation.current) setFileMetrics(metrics);
        });
        setError("");
        connected.onDisconnect(() => {
          if (!stopped && gen === generation.current) {
            clientRef.current = null;
            setConnection("连接已断开");
            setFileMetrics(null);
            setError("文件连接已断开，正在尝试恢复");
            scheduleRetry(3000);
          }
        });
        try {
          const pending = await listCreateIntents({
            account,
            nodeID: terminal.node_id,
            workspaceID: view.workspace.id,
            rootRevision: view.workspace.root_revision,
          });
          const deleted = await listDeletedDrafts({
            account,
            nodeID: terminal.node_id,
            workspaceID: view.workspace.id,
            rootRevision: view.workspace.root_revision,
          });
          const recoverable = await listRecoverableDrafts({
            account,
            nodeID: terminal.node_id,
            workspaceID: view.workspace.id,
            rootRevision: view.workspace.root_revision,
          });
          if (!stopped && gen === generation.current) setDeletedDrafts(deleted);
          if (!stopped && gen === generation.current)
            setRecoverableDrafts(recoverable);
          if (!stopped && gen === generation.current)
            setIntents((old) => [
              ...pending,
              ...old.filter(
                (item) => !pending.some((other) => other.opID === item.opID),
              ),
            ]);
        } catch (e) {
          if (!stopped && gen === generation.current)
            setError("无法读取待确认的文件操作：" + (e as Error).message);
        }
        try {
          await loadDirectory(connected, ".", gen);
        } catch (e) {
          if (
            e instanceof FileServiceError &&
            [
              "ROOT_UNAVAILABLE",
              "ROOT_REPLACED",
              "DIRECTORY_UNAVAILABLE",
              "NOT_DIRECTORY",
              "NOT_FOUND",
            ].includes(e.code) &&
            !stopped &&
            gen === generation.current &&
            clientRef.current === connected
          ) {
            setError(
              `无法读取工作区目录：${e.message}。仍可核对节点待处理写入。`,
            );
          } else throw e;
        }
      } catch (e) {
        if (!stopped && gen === generation.current) {
          setError((e as Error).message);
          setConnection("连接失败");
          scheduleRetry(5000);
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

  useEffect(() => {
    setArchivedRecords([]);
    setArchivedIntents([]);
    setArchivedIntentsTruncated(false);
    if (!enabled || !workspace || !terminal || !account) return;
    const scope = {
      account,
      nodeID: terminal.node_id,
      workspaceID: workspace.id,
      rootRevision: workspace.root_revision,
    };
    let stopped = false;
    const refreshArchives = async () => {
      try {
        const [drafts, operations] = await Promise.all([
          listArchivedDrafts(scope),
          listArchivedIntents(scope),
        ]);
        if (!stopped) {
          setArchivedRecords(drafts);
          setArchivedIntents(operations.items);
          setArchivedIntentsTruncated(operations.truncated);
        }
      } catch (e) {
        if (!stopped) setError("无法读取旧目录草稿：" + (e as Error).message);
      }
    };
    const visible = () => {
      if (globalThis.document.visibilityState === "visible")
        void refreshArchives();
    };
    void refreshArchives();
    const timer = window.setInterval(visible, 10000);
    globalThis.document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearInterval(timer);
      globalThis.document.removeEventListener("visibilitychange", visible);
    };
  }, [
    enabled,
    workspace?.id,
    workspace?.root_revision,
    terminal?.node_id,
    account,
  ]);

  const exportArchivedDraft = useCallback(
    async (
      identity: DraftIdentity,
      source: "page" | "stored",
    ): Promise<Draft> => {
      if (
        !workspace ||
        !terminal ||
        identity.account !== account ||
        identity.nodeID !== terminal.node_id ||
        identity.workspaceID !== workspace.id ||
        identity.rootRevision === workspace.root_revision
      )
        throw new Error("旧目录草稿不属于当前工作区");
      const doc = docs.current.get(documentKey(identity));
      if (source === "page") {
        if (!doc) throw new Error("页面中的旧目录草稿已关闭");
        return {
          identity: doc.identity,
          baseVersion: doc.version,
          baseText: doc.base,
          text: doc.text,
          sequence: doc.sequence,
          encoding: doc.encoding,
          newline: doc.newline,
          pendingSave: doc.pending,
          deleted: doc.deleted,
          unavailable: doc.unavailable,
          manualSaveRequired: doc.manualSaveRequired,
        };
      }
      const draft = await loadDraft(identity);
      if (
        !draft ||
        typeof draft.text !== "string" ||
        typeof draft.baseText !== "string"
      )
        throw new Error("旧目录草稿不可用");
      return draft;
    },
    [account, workspace, terminal?.node_id],
  );
  const checkArchivedScope = useCallback(
    (intent: CreateIntent) => {
      const w = workspace,
        client = clientRef.current;
      if (
        !w ||
        !terminal ||
        !client ||
        intent.account !== account ||
        intent.nodeID !== terminal.node_id ||
        intent.workspaceID !== w.id ||
        intent.rootRevision >= w.root_revision ||
        client.workspace.id !== w.id ||
        client.workspace.root_revision !== w.root_revision
      )
        throw new Error("工作区已改变或旧操作不属于当前工作区");
      return client;
    },
    [account, workspace, terminal?.node_id],
  );
  const inspectArchivedIntent = useCallback(
    async (intent: CreateIntent): Promise<ArchivedOperation> => {
      const client = checkArchivedScope(intent);
      if (!supportsArchive)
        throw new Error("请升级节点后核对旧操作记录；可以先导出本地记录");
      const result = await client.archivedOperationStatus(
        intent.opID,
        intent.rootRevision,
      );
      if (
        clientRef.current !== client ||
        !matchesArchivedIntent(intent, result)
      )
        throw new Error("节点记录与本地操作不匹配，请保留并人工核对");
      return result;
    },
    [checkArchivedScope, supportsArchive],
  );
  const inspectArchivedSave = useCallback(
    async (
      identity: DraftIdentity,
      source: "page" | "stored",
    ): Promise<ArchivedOperation> => {
      const draft = await exportArchivedDraft(identity, source),
        pending = draft.pendingSave;
      if (!pending) throw new Error("该草稿没有待确认保存");
      const client = checkArchivedScope({
        ...identity,
        opID: pending.opID,
        kind: "file",
        createdAt: 0,
      });
      if (!supportsArchive)
        throw new Error("请升级节点后核对旧保存；草稿和记录仍可导出");
      const result = await client.archivedOperationStatus(
          pending.opID,
          identity.rootRevision,
        ),
        spec = result.write;
      if (
        clientRef.current !== client ||
        result.kind !== "write" ||
        result.path !== pending.spec.path ||
        !spec ||
        spec.path !== pending.spec.path ||
        spec.size !== pending.spec.size ||
        spec.sha256 !== pending.spec.sha256 ||
        !!spec.create !== !!pending.spec.create ||
        (spec.base_version || "") !== (pending.spec.base_version || "")
      )
        throw new Error("节点记录与本地保存快照不匹配，请保留并人工核对");
      return result;
    },
    [checkArchivedScope, exportArchivedDraft, supportsArchive],
  );
  const archivedDeleteOutcomes = useCallback(
    async (intent: CreateIntent, offset: number) => {
      if (intent.kind !== "delete") throw new Error("此操作不是删除记录");
      const client = checkArchivedScope(intent);
      const status = await inspectArchivedIntent(intent);
      if (
        status.kind !== "entry.delete" ||
        !status.delete ||
        status.details_expired
      )
        throw new Error("旧删除结果明细不可用，请保留记录并人工核对");
      if (clientRef.current !== client) throw new Error("工作区连接已改变");
      return client.archivedDeleteOutcomes(
        intent.opID,
        intent.rootRevision,
        offset,
      );
    },
    [checkArchivedScope, inspectArchivedIntent],
  );
  const forgetArchivedIntent = useCallback(
    async (intent: CreateIntent) => {
      checkArchivedScope(intent);
      if (activeIntents.current.has(intent.opID))
        throw new Error("操作正在处理，请稍后重试");
      await removeArchivedIntent(intent);
      setArchivedIntents((old) =>
        old.filter((item) => item.opID !== intent.opID),
      );
    },
    [checkArchivedScope],
  );

  const refreshActive = useRef(false);
  const refreshPending = useRef(false);
  const refreshLatest = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    const client = clientRef.current,
      gen = generation.current;
    if (!client || renameLock.current) return;
    if (refreshActive.current) {
      refreshPending.current = true;
      return;
    }
    refreshActive.current = true;
    try {
      for (const path of expanded) await loadDirectory(client, path, gen);
      const doc = selected ? docs.current.get(selected) : undefined;
      if (
        doc &&
        workspace &&
        doc.identity.account === account &&
        doc.identity.workspaceID === workspace.id &&
        doc.identity.rootRevision === workspace.root_revision &&
        !doc.deleted &&
        !doc.conflict &&
        !doc.pending &&
        !doc.saving &&
        !doc.closing
      ) {
        const version = doc.version,
          sequence = doc.sequence;
        const unchanged = () =>
          gen === generation.current &&
          clientRef.current === client &&
          docs.current.get(selected!) === doc &&
          doc.version === version &&
          doc.sequence === sequence &&
          !doc.saving &&
          !doc.closing &&
          !doc.pending &&
          !doc.deleted &&
          !doc.conflict &&
          !renameLock.current;
        try {
          const stat = await client.stat(doc.path);
          if (unchanged() && doc.message.startsWith("无法刷新文件：")) {
            doc.message = "";
            update();
          }
          if (
            unchanged() &&
            (stat.kind !== "file" || !stat.version || stat.version !== version)
          ) {
            if (
              doc.text !== doc.base ||
              doc.persistenceError ||
              stat.kind !== "file" ||
              !stat.version
            ) {
              doc.conflict = true;
              doc.message = "远端文件已变化，请先处理本地草稿。";
              await persist(doc).catch(() => {});
            } else {
              const { entry, bytes } = await client.readBytes(
                doc.path,
                stat.version,
              );
              if (!entry.version || entry.version !== stat.version)
                throw new Error("读取的文件版本不一致");
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes,
              );
              if (text.includes("\0"))
                throw new Error("远端文件不是可编辑的 UTF-8 文本");
              const bom =
                bytes.length >= 3 &&
                bytes[0] === 0xef &&
                bytes[1] === 0xbb &&
                bytes[2] === 0xbf;
              const crlf = (text.match(/\r\n/g) || []).length,
                bareLF = (text.match(/(?<!\r)\n/g) || []).length,
                bareCR = (text.match(/\r(?!\n)/g) || []).length;
              if (unchanged() && doc.text === doc.base) {
                doc.base = text;
                doc.text = text;
                doc.version = entry.version!;
                doc.encoding = bom ? "utf8-bom" : "utf8";
                doc.newline = crlf ? "crlf" : "lf";
                doc.warning =
                  bareCR || (crlf && bareLF)
                    ? "文件包含混合换行，暂不能安全保存"
                    : "";
                doc.message = "";
                await persist(doc).catch(() => {});
              }
            }
            update();
          }
        } catch (e) {
          if (
            unchanged() &&
            e instanceof FileServiceError &&
            e.code === "NOT_FOUND"
          ) {
            doc.conflict = true;
            doc.unavailable = true;
            doc.message = "文件不存在或无法访问，本地内容已保留。";
            try {
              await persist(doc);
              if (gen === generation.current)
                setRecoverableDrafts((old) =>
                  old.some((d) => documentKey(d) === documentKey(doc.identity))
                    ? old
                    : [...old, doc.identity],
                );
            } catch {}
            update();
          } else if (
            unchanged() &&
            !(e instanceof FileServiceError && e.code === "FILE_CHANGED")
          ) {
            doc.message = `无法刷新文件：${(e as Error).message}`;
            update();
          }
        }
      }
      if (gen === generation.current) setError("");
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    } finally {
      refreshActive.current = false;
      if (refreshPending.current) {
        refreshPending.current = false;
        queueMicrotask(() => void refreshLatest.current());
      }
    }
  }, [account, expanded, loadDirectory, persist, selected, update, workspace]);
  refreshLatest.current = refresh;
  useEffect(() => {
    if (!enabled || !workspace) return;
    const timer = window.setInterval(() => {
      if (globalThis.document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [enabled, workspace, refresh]);
  useEffect(() => {
    if (!enabled || !workspace || !supportsWatch) return;
    const abort = new AbortController();
    let stopped = false,
      watcher: FileClient | undefined,
      retry = 0,
      debounce = 0;
    const paths = Array.from(expanded).slice(0, 64);
    const invalidate = () => {
      if (debounce) return;
      debounce = window.setTimeout(() => {
        debounce = 0;
        if (!stopped) void refresh();
      }, 250);
    };
    const run = async () => {
      try {
        const opened = await FileClient.connect(workspace, abort.signal, false);
        if (stopped) {
          opened.close();
          return;
        }
        watcher = opened;
        await opened.openWatch(paths);
        if (stopped) return;
        invalidate(); // install the watch first, then reconcile changes during installation
        let generation = 0;
        while (!stopped) {
          const event = await opened.pollWatch(5000);
          if (stopped) return;
          if (generation && generation !== event.generation) {
            invalidate();
            break;
          }
          generation = event.generation;
          if (event.changed || event.reset) invalidate();
          if (event.reset) break;
          if (event.changed)
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
      } catch {
        // The ten-second reconciliation remains available while a watcher
        // reconnects, or when a filesystem cannot provide notifications.
      } finally {
        watcher?.close();
        watcher = undefined;
        if (!stopped) retry = window.setTimeout(() => void run(), 2000);
      }
    };
    void run();
    return () => {
      stopped = true;
      abort.abort();
      watcher?.close();
      if (retry) clearTimeout(retry);
      if (debounce) clearTimeout(debounce);
    };
  }, [enabled, workspace, supportsWatch, expanded, refresh]);
  useEffect(() => {
    if (
      enabled &&
      workspace &&
      (connection === "中转连接" || connection === "WebRTC 直连")
    )
      void refresh();
  }, [enabled, workspace, connection, refresh]);
  useEffect(() => {
    if (!enabled || !workspace) return;
    const visible = () => {
      if (globalThis.document.visibilityState === "visible") void refresh();
    };
    globalThis.document.addEventListener("visibilitychange", visible);
    return () =>
      globalThis.document.removeEventListener("visibilitychange", visible);
  }, [enabled, workspace, refresh]);
  const toggle = useCallback(
    async (path: string) => {
      if (renameLock.current) return;
      setSelectedDirectory(path);
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
    async (path: string, restore = false) => {
      if (renameLock.current) return;
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
      const resolvePending = () => {
        const scope = JSON.stringify({
          account,
          nodeID: terminal.node_id,
          workspaceID: w.id,
          rootRevision: w.root_revision,
        });
        const pending = pendingTabs.current;
        if (
          !restore &&
          pending?.scope === scope &&
          pending.paths.includes(path)
        ) {
          pending.paths = pending.paths.filter((item) => item !== path);
          if (pending.selected === path) pending.selected = null;
          setUnrestoredTabs([...pending.paths]);
        }
      };
      const restoration = restore ? restoringTabs.current : null;
      if (!restore) tabInteraction.current++;
      const allowed = () =>
        gen === generation.current &&
        (!restore ||
          (!!restoration &&
            restoringTabs.current === restoration &&
            !restoration.closed.has(path)));
      if (docs.current.has(key)) {
        if (!restore) {
          resolvePending();
          selections.current.set(w.id, key);
          setSelected(key);
        }
        return;
      }
      try {
        const kind = previewKind(path);
        if (kind) {
          const entry = await client.stat(path);
          if (!allowed()) return;
          if (entry.kind !== "file" || !entry.version)
            throw new Error("文件无法预览");
          if (previews.current.has(key) && restore) return;
          previews.current.set(key, {
            identity,
            path,
            kind,
            version: entry.version,
            size: entry.size,
          });
          if (!restore) {
            resolvePending();
            selections.current.set(w.id, key);
            setSelected(key);
          }
          update();
          return;
        }
        let content: Awaited<ReturnType<FileClient["readBytes"]>>;
        try {
          content = await client.readBytes(path);
        } catch (e) {
          if (!(e instanceof FileServiceError) || e.code !== "FILE_TOO_LARGE")
            throw e;
          const entry = await client.stat(path);
          if (!allowed()) return;
          if (docs.current.has(key)) {
            if (!restore) {
              resolvePending();
              selections.current.set(w.id, key);
              setSelected(key);
            }
            return;
          }
          if (
            entry.kind !== "file" ||
            !entry.version ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0
          )
            throw new Error("文件无法预览");
          if (previews.current.has(key) && restore) return;
          previews.current.set(key, {
            identity,
            path,
            kind: "large-text",
            version: entry.version,
            size: entry.size,
          });
          if (!restore) {
            resolvePending();
            selections.current.set(w.id, key);
            setSelected(key);
          }
          update();
          return;
        }
        const { entry, bytes } = content;
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
        if (saved?.deleted)
          throw new Error("此路径有已删除文件的草稿，请先从左侧打开并导出草稿");
        if (saved?.unavailable)
          throw new Error(
            "此路径有不可访问文件的草稿，请先从左侧打开并处理草稿",
          );
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
        // A rename changes inode metadata even when the bytes do not change.
        // Rebase only after comparing the exact decoded base and encoding;
        // later writes still use the freshly observed version as a CAS guard.
        if (
          saved &&
          !saved.pendingSave &&
          saved.baseVersion !== entry.version &&
          saved.baseText === text &&
          saved.encoding === (bom ? "utf8-bom" : "utf8")
        )
          saved.baseVersion = entry.version;
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
        if (!allowed()) return;
        if (docs.current.has(key)) {
          if (!restore) {
            resolvePending();
            selections.current.set(w.id, key);
            setSelected(key);
          }
          return;
        }
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
          manualSaveRequired: saved?.manualSaveRequired,
          saving: false,
          conflict: !!saved && saved.baseVersion !== entry.version,
          warning,
          message: saved?.manualSaveRequired
            ? "已采用远端版本作为基准；请检查后手动保存。"
            : "",
          persistenceError,
        };
        previews.current.delete(key);
        docs.current.set(key, doc);
        if (!restore) {
          resolvePending();
          selections.current.set(w.id, key);
          setSelected(key);
        }
        update();
      } catch (e) {
        if (!restore && gen === generation.current)
          setError((e as Error).message);
      }
    },
    [workspace, terminal?.id, terminal?.node_id, account, update],
  );
  const tabScope: WorkspaceViewScope | null =
    workspace && terminal && account
      ? {
          account,
          nodeID: terminal.node_id,
          workspaceID: workspace.id,
          rootRevision: workspace.root_revision,
        }
      : null;
  const tabScopeKey = tabScope ? JSON.stringify(tabScope) : "";
  useEffect(() => {
    setTabsReady("");
    setUnrestoredTabs([]);
    lastTabs.current = "";
    if (!enabled || !tabScope || !workspace || !clientRef.current) return;
    const scope = tabScope;
    const current = { scope: tabScopeKey, closed: new Set<string>() };
    restoringTabs.current = current;
    const startInteraction = tabInteraction.current;
    let cancelled = false;
    let loaded = false;
    let previous: WorkspaceTabs | undefined;
    const flushRestoring = () => {
      if (!loaded || cancelled || restoringTabs.current !== current) return;
      const items = [
        ...docs.current.values(),
        ...previews.current.values(),
      ].filter(
        (item) =>
          item.identity.account === scope.account &&
          item.identity.nodeID === scope.nodeID &&
          item.identity.workspaceID === scope.workspaceID &&
          item.identity.rootRevision === scope.rootRevision,
      );
      const paths = Array.from(
        new Set([
          ...(previous?.paths || []).filter(
            (path) => !current.closed.has(path),
          ),
          ...items.map((item) => item.path),
        ]),
      );
      const selectedID = selections.current.get(scope.workspaceID);
      const selected =
        tabInteraction.current === startInteraction &&
        previous?.selected &&
        paths.includes(previous.selected)
          ? previous.selected
          : items.find((item) => documentKey(item.identity) === selectedID)
              ?.path || null;
      void writeWorkspaceTabs(scope, { paths, selected }).catch((e) =>
        setError("无法保存文件标签状态：" + (e as Error).message),
      );
    };
    window.addEventListener("pagehide", flushRestoring);
    const run = async () => {
      try {
        const saved = await readWorkspaceTabs(scope);
        if (cancelled || restoringTabs.current !== current) return;
        previous = saved;
        loaded = true;
        const failed: string[] = [];
        for (const path of saved?.paths || []) {
          if (cancelled || restoringTabs.current !== current) return;
          if (current.closed.has(path)) continue;
          await openFile(path, true);
          if (cancelled || restoringTabs.current !== current) return;
          const id = documentKey({ ...scope, path });
          if (
            !current.closed.has(path) &&
            !docs.current.has(id) &&
            !previews.current.has(id)
          )
            failed.push(path);
        }
        if (cancelled || restoringTabs.current !== current) return;
        const selectedID = saved?.selected
          ? documentKey({ ...scope, path: saved.selected })
          : null;
        if (
          tabInteraction.current === startInteraction &&
          selectedID &&
          (docs.current.has(selectedID) || previews.current.has(selectedID))
        ) {
          selections.current.set(scope.workspaceID, selectedID);
          setSelected(selectedID);
        }
        const missing = failed.filter((path) => {
          const id = documentKey({ ...scope, path });
          return (
            !current.closed.has(path) &&
            !docs.current.has(id) &&
            !previews.current.has(id)
          );
        });
        pendingTabs.current = {
          scope: tabScopeKey,
          paths: missing,
          selected: missing.includes(saved?.selected || "")
            ? saved!.selected
            : null,
          interaction: startInteraction,
        };
        setUnrestoredTabs(missing);
        restoringTabs.current = null;
        setTabsReady(tabScopeKey);
      } catch (e) {
        if (!cancelled && restoringTabs.current === current) {
          restoringTabs.current = null;
          setError("无法读取文件标签状态：" + (e as Error).message);
        }
      }
    };
    void run();
    return () => {
      flushRestoring();
      cancelled = true;
      window.removeEventListener("pagehide", flushRestoring);
      if (restoringTabs.current === current) restoringTabs.current = null;
    };
  }, [enabled, tabScopeKey, openFile]);
  useEffect(() => {
    if (!tabScope || !tabScopeKey || tabsReady !== tabScopeKey) return;
    const scope = tabScope;
    const saveTabs = () => {
      const items = [
        ...docs.current.values(),
        ...previews.current.values(),
      ].filter(
        (item) =>
          item.identity.account === scope.account &&
          item.identity.nodeID === scope.nodeID &&
          item.identity.workspaceID === scope.workspaceID &&
          item.identity.rootRevision === scope.rootRevision,
      );
      const missing =
        pendingTabs.current?.scope === tabScopeKey ? pendingTabs.current : null;
      const paths = Array.from(
        new Set([...items.map((item) => item.path), ...(missing?.paths || [])]),
      );
      const selectedID = selections.current.get(scope.workspaceID);
      const selectedPath =
        items.find((item) => documentKey(item.identity) === selectedID)?.path ||
        (missing && missing.interaction === tabInteraction.current
          ? missing.selected
          : null);
      const state = { paths, selected: selectedPath };
      const snapshot = JSON.stringify(state);
      if (lastTabs.current === snapshot) return;
      lastTabs.current = snapshot;
      void writeWorkspaceTabs(scope, state).catch((e) => {
        if (lastTabs.current === snapshot) lastTabs.current = "";
        setError("无法保存文件标签状态：" + (e as Error).message);
      });
    };
    saveTabs();
    window.addEventListener("pagehide", saveTabs);
    return () => {
      window.removeEventListener("pagehide", saveTabs);
      saveTabs();
    };
  }, [tabScopeKey, tabsReady, selected, revision]);
  const selectedDocument = selected ? docs.current.get(selected) : undefined;
  const openDeletedDraft = useCallback(
    async (identity: DraftIdentity) => {
      tabInteraction.current++;
      const w = workspace;
      if (
        !w ||
        identity.workspaceID !== w.id ||
        identity.rootRevision !== w.root_revision ||
        identity.account !== account
      )
        throw new Error("工作区已切换");
      const id = documentKey(identity),
        existing = docs.current.get(id);
      if (existing) {
        setSelected(id);
        selections.current.set(w.id, id);
        return;
      }
      const saved = await loadDraft(identity);
      if (!saved?.deleted) throw new Error("已删除草稿不可用");
      const doc: Document = {
        identity,
        path: identity.path,
        base: saved.baseText,
        text: saved.text,
        version: saved.baseVersion,
        sequence: saved.sequence,
        encoding: saved.encoding,
        newline: saved.newline,
        token: saved.token,
        pending: saved.pendingSave,
        saving: false,
        conflict: true,
        deleted: true,
        warning: "",
        message: "文件已删除，草稿保留在当前浏览器。",
        persistenceError: "",
      };
      docs.current.set(id, doc);
      selections.current.set(w.id, id);
      setSelected(id);
      update();
    },
    [workspace, account, update],
  );
  const openRecoverableDraft = useCallback(
    async (identity: DraftIdentity) => {
      tabInteraction.current++;
      const client = clientRef.current,
        w = workspace,
        gen = generation.current;
      if (
        !client ||
        !w ||
        identity.account !== account ||
        identity.nodeID !== terminal?.node_id ||
        identity.workspaceID !== w.id ||
        identity.rootRevision !== w.root_revision
      )
        throw new Error("工作区已切换或文件连接不可用");
      const id = documentKey(identity),
        existing = docs.current.get(id);
      if (existing) {
        selections.current.set(w.id, id);
        setSelected(id);
        return;
      }
      const saved = await loadDraft(identity);
      if (!saved || saved.deleted) throw new Error("本地草稿不可用");
      let unavailable = !!saved.unavailable;
      if (!unavailable) {
        try {
          await client.stat(identity.path);
        } catch (e) {
          if (e instanceof FileServiceError && e.code === "NOT_FOUND")
            unavailable = true;
          else throw e;
        }
      }
      if (gen !== generation.current || clientRef.current !== client)
        throw new Error("工作区已切换");
      if (!unavailable) {
        await openFile(identity.path);
        return;
      }
      const doc: Document = {
        identity,
        path: identity.path,
        base: saved.baseText,
        text: saved.text,
        version: saved.baseVersion,
        sequence: saved.sequence,
        encoding: saved.encoding,
        newline: saved.newline,
        token: saved.token,
        pending: saved.pendingSave,
        saving: false,
        conflict: true,
        unavailable: true,
        warning: "",
        message: "文件不存在或无法访问，本地内容已保留。",
        persistenceError: "",
      };
      docs.current.set(id, doc);
      selections.current.set(w.id, id);
      setSelected(id);
      update();
      if (!saved.unavailable) await persist(doc).catch(() => {});
    },
    [workspace, account, terminal?.node_id, openFile, persist, update],
  );
  const saveDeletedAs = useCallback(
    async (
      doc: Document,
      name: string,
      parent: string,
      expectedWorkspace: string,
      expectedRevision: number,
    ) => {
      const client = clientRef.current;
      if (
        !client ||
        (!doc.deleted && !doc.unavailable) ||
        doc.identity.account !== account ||
        client.workspace.id !== expectedWorkspace ||
        client.workspace.root_revision !== expectedRevision ||
        doc.identity.workspaceID !== expectedWorkspace ||
        doc.identity.rootRevision !== expectedRevision ||
        doc.saving ||
        renameLock.current
      )
        throw new Error("草稿或文件连接不可用");
      if (
        !doc.pending &&
        (!name ||
          name === "." ||
          name === ".." ||
          /[\/\\\u0000-\u001f]/.test(name) ||
          new TextEncoder().encode(name).length > 255)
      )
        throw new Error("新文件名无效");
      if (doc.pending && !doc.pending.spec.create)
        throw new Error("存在其他待确认的保存，请先核对");
      doc.saving = true;
      doc.message = "";
      update();
      try {
        let transaction = doc.pending;
        if (!transaction) {
          let bytes = new TextEncoder().encode(doc.text);
          if (doc.encoding === "utf8-bom") {
            const bom = new Uint8Array(bytes.length + 3);
            bom.set([0xef, 0xbb, 0xbf]);
            bom.set(bytes, 3);
            bytes = bom;
          }
          transaction = await client.prepareSave(
            childPath(parent, name),
            bytes,
            "",
            true,
          );
          doc.pending = transaction;
        }
        await persist(doc);
        const saved = await client.save(transaction);
        if (saved.state !== "committed" || !saved.version)
          throw new Error("另存结果尚未确认");
        doc.pending = undefined;
        try {
          await persist(doc);
        } catch (e) {
          doc.pending = transaction;
          throw e;
        }
        doc.message = `已另存到 ${transaction.spec.path}；原草稿仍保留。`;
        if (clientRef.current === client) await refresh();
      } catch (e) {
        if (
          e instanceof FileServiceError &&
          ["ALREADY_EXISTS", "CONFLICT"].includes(e.code)
        ) {
          doc.pending = undefined;
          await persist(doc).catch(() => {});
        }
        doc.message = (e as Error).message;
        throw e;
      } finally {
        doc.saving = false;
        update();
      }
    },
    [account, persist, refresh, update],
  );
  const discardDeletedDraft = useCallback(
    async (doc: Document) => {
      if (
        (!doc.deleted && !doc.unavailable) ||
        doc.identity.account !== account ||
        doc.pending ||
        doc.saving ||
        !doc.token ||
        renameLock.current
      )
        throw new Error("草稿不可移除，或存在待确认的另存操作");
      renameLock.current = true;
      setRenaming(true);
      try {
        const id = documentKey(doc.identity),
          timer = timers.current.get(id);
        if (timer) {
          clearTimeout(timer);
          timers.current.delete(id);
        }
        await queues.current.get(id)?.catch(() => {});
        if (!doc.token) throw new Error("草稿令牌不可用");
        await deleteDraft(doc.identity, doc.token);
        tabInteraction.current++;
        restoringTabs.current?.closed.add(doc.path);
        docs.current.delete(id);
        if (selections.current.get(doc.identity.workspaceID) === id)
          selections.current.delete(doc.identity.workspaceID);
        setSelected((old) => (old === id ? null : old));
        setDeletedDrafts((old) => old.filter((d) => documentKey(d) !== id));
        setRecoverableDrafts((old) => old.filter((d) => documentKey(d) !== id));
        update();
      } finally {
        renameLock.current = false;
        setRenaming(false);
      }
    },
    [account, update],
  );
  const selectedPreview = selected ? previews.current.get(selected) : undefined;
  const document =
    selectedDocument?.identity.workspaceID === workspace?.id &&
    selectedDocument?.identity.rootRevision === workspace?.root_revision &&
    selectedDocument?.identity.account === account
      ? selectedDocument
      : undefined;
  const preview =
    selectedPreview?.identity.workspaceID === workspace?.id &&
    selectedPreview?.identity.rootRevision === workspace?.root_revision &&
    selectedPreview?.identity.account === account
      ? selectedPreview
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
  const readConflict = useCallback(
    async (doc: Document): Promise<ConflictSnapshot> => {
      const client = clientRef.current,
        gen = generation.current;
      if (
        !client ||
        !doc.conflict ||
        doc.deleted ||
        doc.unavailable ||
        doc.pending ||
        doc.saving ||
        renameLock.current ||
        doc.identity.account !== account ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision
      )
        throw new Error("请先核对待确认保存，并确保远端文件可访问");
      const { entry, bytes } = await client.readBytes(doc.path);
      if (
        gen !== generation.current ||
        clientRef.current !== client ||
        docs.current.get(documentKey(doc.identity)) !== doc ||
        !doc.conflict ||
        doc.pending
      )
        throw new Error("工作区或草稿状态已改变，请重新比较");
      if (!entry.version || entry.kind !== "file" || entry.restricted)
        throw new Error("远端文件不可比较");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0"))
        throw new Error("远端文件不是可编辑的 UTF-8 文本");
      return { text, version: entry.version, key: documentKey(doc.identity) };
    },
    [account],
  );
  const acceptConflictBase = useCallback(
    async (doc: Document, snapshot: ConflictSnapshot) => {
      const client = clientRef.current,
        gen = generation.current;
      if (
        !client ||
        snapshot.key !== documentKey(doc.identity) ||
        !doc.conflict ||
        doc.deleted ||
        doc.unavailable ||
        doc.pending ||
        doc.saving ||
        doc.warning ||
        renameLock.current ||
        doc.identity.account !== account ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision
      )
        throw new Error("草稿状态已改变，请重新比较");
      doc.saving = true;
      update();
      try {
        const current = await client.stat(doc.path);
        if (
          gen !== generation.current ||
          clientRef.current !== client ||
          docs.current.get(documentKey(doc.identity)) !== doc ||
          !doc.conflict ||
          doc.pending ||
          renameLock.current
        )
          throw new Error("工作区或草稿状态已改变，请重新比较");
        if (
          current.kind !== "file" ||
          current.restricted ||
          current.version !== snapshot.version
        )
          throw new Error("远端文件再次变化，请重新比较");
        const before = {
          base: doc.base,
          version: doc.version,
          conflict: doc.conflict,
          message: doc.message,
          manualSaveRequired: doc.manualSaveRequired,
        };
        doc.base = snapshot.text;
        doc.version = snapshot.version;
        doc.conflict = false;
        doc.manualSaveRequired = true;
        doc.message =
          "已采用所比较的远端版本作为基准；本地草稿未写入，请检查后手动保存。";
        try {
          await persist(doc);
        } catch (e) {
          Object.assign(doc, before);
          throw e;
        }
      } finally {
        doc.saving = false;
        update();
      }
    },
    [account, persist, update],
  );
  const checkPendingSave = useCallback(
    async (doc: Document, cancel = false) => {
      const client = clientRef.current,
        transaction = doc.pending,
        gen = generation.current;
      if (
        !client ||
        !transaction ||
        doc.saving ||
        renameLock.current ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision ||
        doc.identity.account !== account
      ) {
        doc.message = "待确认保存或文件连接不可用";
        update();
        return;
      }
      doc.saving = true;
      doc.pendingState = undefined;
      update();
      try {
        let operation = await client.operationStatus(transaction.opID);
        if (
          gen !== generation.current ||
          clientRef.current !== client ||
          doc.pending !== transaction
        )
          throw new Error("工作区已切换，请重新核对保存状态");
        if (operation.offset > transaction.content.length)
          throw new Error("节点返回的保存偏移无效，请重新核对");
        if (cancel && ["receiving", "ready"].includes(operation.state))
          operation = await client.abortSave(transaction);
        if (
          gen !== generation.current ||
          clientRef.current !== client ||
          doc.pending !== transaction
        )
          throw new Error("工作区已切换，请重新核对保存状态");
        if (operation.offset > transaction.content.length)
          throw new Error("节点返回的保存偏移无效，请重新核对");
        if (operation.state === "receiving" || operation.state === "ready") {
          doc.pendingState = operation.state;
          doc.message = `保存尚未提交，节点已确认 ${operation.offset} / ${transaction.content.length} 字节。${doc.conflict || doc.deleted || doc.unavailable ? "请取消未完成保存后处理草稿。" : "可继续原保存或取消未完成保存。"}`;
        } else if (
          operation.state === "committed" ||
          operation.state === "aborted" ||
          operation.state === "conflict"
        ) {
          if (operation.state === "committed" && !operation.version)
            throw new Error("节点未返回已提交文件的版本，请稍后重新核对");
          let matches = false,
            missing = false;
          if (operation.state === "committed" && !transaction.spec.create) {
            try {
              const current = await client.stat(doc.path);
              matches =
                current.kind === "file" &&
                current.version === operation.version;
            } catch (e) {
              if (e instanceof FileServiceError && e.code === "NOT_FOUND")
                missing = true;
            }
            if (
              gen !== generation.current ||
              clientRef.current !== client ||
              doc.pending !== transaction
            )
              throw new Error("工作区已切换，请重新核对保存状态");
          }
          const before = {
            base: doc.base,
            version: doc.version,
            conflict: doc.conflict,
            unavailable: doc.unavailable,
            message: doc.message,
            manualSaveRequired: doc.manualSaveRequired,
          };
          if (operation.state === "committed" && !transaction.spec.create) {
            doc.base = new TextDecoder().decode(transaction.content);
            doc.version = operation.version!;
            doc.manualSaveRequired = false;
            doc.conflict = !matches || !!doc.deleted;
            if (matches && !doc.deleted) doc.unavailable = false;
            else if (missing) doc.unavailable = true;
            doc.message =
              matches && !doc.deleted
                ? "已确认保存；之后的编辑仍保留。"
                : "已确认先前保存，但当前文件已变化或不可访问，请先处理草稿。";
          } else if (operation.state === "committed") {
            doc.message = `已确认另存到 ${transaction.spec.path}；原草稿仍保留。`;
          } else if (operation.state === "conflict") {
            doc.conflict = true;
            doc.message =
              operation.error?.message || "保存未提交，远端文件发生冲突。";
          } else {
            doc.message = "未完成的保存已取消，本地草稿仍保留。";
          }
          doc.pending = undefined;
          try {
            await persist(doc);
          } catch (e) {
            doc.pending = transaction;
            Object.assign(doc, before);
            throw e;
          }
          if (!doc.unavailable && !doc.deleted && doc.text === doc.base)
            setRecoverableDrafts((old) =>
              old.filter((d) => documentKey(d) !== documentKey(doc.identity)),
            );
        } else {
          doc.message =
            "节点暂不能确认保存结果，请稍后再次核对；本地草稿已保留。";
        }
      } catch (e) {
        doc.message =
          e instanceof FileServiceError && e.code === "OPERATION_NOT_FOUND"
            ? "节点没有可查询的原保存记录，无法确定结果；请导出草稿并人工核对。"
            : (e as Error).message;
      } finally {
        doc.saving = false;
        update();
      }
    },
    [account, persist, update],
  );
  const save = useCallback(
    async (doc: Document) => {
      const client = clientRef.current;
      if (
        !client ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision ||
        doc.saving ||
        renameLock.current ||
        doc.deleted ||
        doc.conflict ||
        doc.warning ||
        doc.closing
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
        doc.manualSaveRequired = false;
        await persist(doc);
        if (doc.text === doc.base)
          setRecoverableDrafts((old) =>
            old.filter((d) => documentKey(d) !== documentKey(doc.identity)),
          );
        void refresh();
      } catch (e) {
        if (e instanceof UncertainSaveError) doc.pending = e.transaction;
        if (e instanceof FileServiceError && e.code === "CONFLICT") {
          doc.pending = undefined;
          doc.conflict = true;
        }
        doc.message = (e as Error).message;
        await persist(doc).catch(() => {});
      } finally {
        doc.saving = false;
        update();
      }
    },
    [persist, refresh, update],
  );
  const autoTimers = useRef(
    new Map<string, { sequence: number; timer: number }>(),
  );
  const autoEnabled = useRef(false);
  autoEnabled.current = enabled && autoSave && !!account && !!workspace;
  useEffect(() => {
    const timers = autoTimers.current;
    const eligible = new Set<string>();
    if (enabled && autoSave && workspace && clientRef.current) {
      for (const [id, doc] of docs.current) {
        if (
          doc.identity.account !== account ||
          doc.identity.workspaceID !== workspace.id ||
          doc.identity.rootRevision !== workspace.root_revision ||
          doc.text === doc.base ||
          doc.saving ||
          doc.pending ||
          doc.conflict ||
          doc.deleted ||
          doc.warning ||
          doc.message ||
          doc.persistenceError ||
          doc.manualSaveRequired ||
          doc.closing ||
          renameLock.current
        )
          continue;
        eligible.add(id);
        const current = timers.get(id);
        if (current?.sequence === doc.sequence) continue;
        if (current) clearTimeout(current.timer);
        const sequence = doc.sequence;
        const timer = window.setTimeout(() => {
          timers.delete(id);
          if (
            autoEnabled.current &&
            doc.sequence === sequence &&
            docs.current.get(id) === doc &&
            doc.text !== doc.base &&
            !doc.saving &&
            !doc.pending &&
            !doc.conflict &&
            !doc.deleted &&
            !doc.warning &&
            !doc.message &&
            !doc.persistenceError &&
            !doc.manualSaveRequired &&
            !doc.closing &&
            !renameLock.current
          )
            void save(doc);
        }, 1500);
        timers.set(id, { sequence, timer });
      }
    }
    for (const [id, entry] of timers)
      if (!eligible.has(id)) {
        clearTimeout(entry.timer);
        timers.delete(id);
      }
  }, [
    account,
    autoSave,
    enabled,
    workspace,
    connection,
    renaming,
    revision,
    save,
  ]);
  useEffect(
    () => () => {
      for (const entry of autoTimers.current.values())
        clearTimeout(entry.timer);
      autoTimers.current.clear();
    },
    [],
  );
  const retry = useCallback(() => setReconnect((n) => n + 1), []);
  const closeDocument = useCallback(
    async (doc: Document, action: "clean" | "save" | "discard" | "keep") => {
      const id = documentKey(doc.identity);
      if (
        docs.current.get(id) !== doc ||
        doc.identity.account !== account ||
        doc.closing ||
        doc.saving ||
        renameLock.current
      )
        throw new Error("文件状态已改变或操作尚未完成");
      if (action === "save") {
        if (
          doc.pending ||
          doc.conflict ||
          doc.deleted ||
          doc.unavailable ||
          doc.warning ||
          doc.persistenceError ||
          !clientRef.current
        )
          throw new Error("请先处理冲突、待确认保存或草稿存储错误");
        await save(doc);
        if (
          docs.current.get(id) !== doc ||
          doc.saving ||
          doc.pending ||
          doc.conflict ||
          doc.text !== doc.base ||
          doc.persistenceError
        )
          throw new Error(doc.message || "文件尚未完整保存，请检查后重试");
      }
      if (
        action === "clean" &&
        (doc.text !== doc.base ||
          doc.pending ||
          doc.conflict ||
          doc.deleted ||
          doc.unavailable ||
          doc.persistenceError)
      )
        throw new Error("文件仍有未处理的草稿，请选择处理方式");
      if (action === "discard" && doc.pending)
        throw new Error("保存结果待确认，请先核对或保留草稿");
      doc.closing = true;
      const sequence = doc.sequence;
      const timer = timers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
      update();
      try {
        await queues.current.get(id)?.catch(() => {});
        if (
          doc.sequence !== sequence ||
          docs.current.get(id) !== doc ||
          (doc.pending && action !== "keep")
        )
          throw new Error("文件内容或保存状态已改变，请重新处理");
        if (action === "keep") {
          await persist(doc);
          if (doc.sequence !== sequence)
            throw new Error("文件内容已改变，请重新处理");
          if (doc.deleted)
            setDeletedDrafts((old) =>
              old.some((d) => documentKey(d) === id)
                ? old
                : [...old, doc.identity],
            );
          else
            setRecoverableDrafts((old) =>
              old.some((d) => documentKey(d) === id)
                ? old
                : [...old, doc.identity],
            );
        } else if (action === "discard") {
          if (doc.token) {
            await deleteDraft(doc.identity, doc.token);
            doc.token = null;
            if (doc.sequence !== sequence) {
              await persist(doc).catch(() => {});
              throw new Error("文件内容已改变，请重新处理");
            }
          }
          setDeletedDrafts((old) => old.filter((d) => documentKey(d) !== id));
          setRecoverableDrafts((old) =>
            old.filter((d) => documentKey(d) !== id),
          );
        }
        tabInteraction.current++;
        restoringTabs.current?.closed.add(doc.path);
        docs.current.delete(id);
        const next =
          [...docs.current.entries(), ...previews.current.entries()]
            .filter(
              ([, item]) =>
                item.identity.account === doc.identity.account &&
                item.identity.workspaceID === doc.identity.workspaceID &&
                item.identity.rootRevision === doc.identity.rootRevision,
            )
            .at(-1)?.[0] || null;
        if (selections.current.get(doc.identity.workspaceID) === id) {
          if (next) selections.current.set(doc.identity.workspaceID, next);
          else selections.current.delete(doc.identity.workspaceID);
        }
        setSelected((current) => (current === id ? next : current));
      } finally {
        doc.closing = false;
        update();
      }
    },
    [account, persist, save, update],
  );
  const closePreview = useCallback(
    (id: string) => {
      const preview = previews.current.get(id);
      if (
        !preview ||
        preview.identity.account !== account ||
        renameLock.current
      )
        return;
      tabInteraction.current++;
      restoringTabs.current?.closed.add(preview.path);
      previews.current.delete(id);
      const next =
        [...docs.current.entries(), ...previews.current.entries()]
          .filter(
            ([, item]) =>
              item.identity.account === preview.identity.account &&
              item.identity.workspaceID === preview.identity.workspaceID &&
              item.identity.rootRevision === preview.identity.rootRevision,
          )
          .at(-1)?.[0] || null;
      if (selections.current.get(preview.identity.workspaceID) === id) {
        if (next) selections.current.set(preview.identity.workspaceID, next);
        else selections.current.delete(preview.identity.workspaceID);
      }
      setSelected((current) => (current === id ? next : current));
      update();
    },
    [account, update],
  );
  const runCreateIntent = useCallback(
    async (intent: CreateIntent) => {
      if (renameLock.current) throw new Error("工作区正在处理其他操作");
      if (intent.kind === "upload" || intent.kind === "rename")
        throw new Error("请重新选择原文件以核对并继续上传");
      const client = clientRef.current;
      if (
        !client ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision
      )
        throw new Error("工作区已断开或目录已改变");
      if (activeIntents.current.has(intent.opID))
        throw new Error("此操作正在进行");
      activeIntents.current.add(intent.opID);
      try {
        let prior;
        try {
          prior = await client.operationStatus(
            intent.opID,
            intent.kind === "directory" ? "directory.create" : "write",
          );
        } catch (e) {
          if (
            !(e instanceof FileServiceError) ||
            e.code !== "OPERATION_NOT_FOUND"
          )
            throw e;
        }
        if (prior?.state === "committed") {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((item) => item.opID !== intent.opID));
          if (clientRef.current === client) await refresh();
          return;
        }
        if (
          prior?.state === "conflict" ||
          prior?.state === "failed" ||
          prior?.state === "aborted"
        ) {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((item) => item.opID !== intent.opID));
          throw new Error(
            prior.error?.message || "文件操作已终止，请检查目标后重试",
          );
        }
        if (prior?.state === "uncertain" || prior?.state === "committing")
          throw new Error("节点尚无法确认创建结果，请检查目标后再处理");
        if (intent.kind === "directory") {
          const result = await client.createDirectory(intent.opID, intent.path);
          if (result.state !== "committed")
            throw new Error("目录创建尚未确认，请稍后核对");
        } else {
          const result = await client.save({
            opID: intent.opID,
            spec: {
              path: intent.path,
              create: true,
              size: 0,
              sha256:
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
            content: new Uint8Array(),
          });
          if (result.state !== "committed")
            throw new Error("文件创建尚未确认，请稍后核对");
        }
        await removeCreateIntent(intent.opID);
        setIntents((old) => old.filter((item) => item.opID !== intent.opID));
        if (clientRef.current === client) await refresh();
      } catch (e) {
        if (
          e instanceof FileServiceError &&
          ["ALREADY_EXISTS", "CONFLICT"].includes(e.code)
        ) {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((item) => item.opID !== intent.opID));
        }
        throw e;
      } finally {
        activeIntents.current.delete(intent.opID);
      }
    },
    [refresh],
  );
  const renameIntent = useCallback(
    async (intent: CreateIntent) => {
      const client = clientRef.current,
        gen = generation.current;
      if (
        !client ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision ||
        intent.kind !== "rename" ||
        !intent.source ||
        !intent.version
      )
        throw new Error("工作区或重命名记录无效");
      if (activeIntents.current.has(intent.opID))
        throw new Error("此操作正在进行");
      activeIntents.current.add(intent.opID);
      const source = intent.source,
        target = intent.path;
      const matches = (p: string) => p === source || p.startsWith(source + "/");
      const sameScope = (id: DraftIdentity) =>
        id.account === intent.account &&
        id.nodeID === intent.nodeID &&
        id.workspaceID === intent.workspaceID &&
        id.rootRevision === intent.rootRevision;
      try {
        const active = Array.from(docs.current.values()).filter(
          (d) => sameScope(d.identity) && matches(d.path),
        );
        if (
          Array.from(docs.current.values()).some(
            (d) =>
              sameScope(d.identity) &&
              (d.path === target || d.path.startsWith(target + "/")),
          ) ||
          Array.from(previews.current.values()).some(
            (p) =>
              sameScope(p.identity) &&
              (p.path === target || p.path.startsWith(target + "/")),
          )
        )
          throw new Error("目标路径已有打开的标签，请先处理");
        for (const doc of active) {
          if (doc.saving || doc.pending)
            throw new Error("请先完成受影响文件的保存或结果核对");
          const oldKey = documentKey(doc.identity),
            timer = timers.current.get(oldKey);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(oldKey);
          }
          await persist(doc);
        }
        await moveDrafts(intent, source, target, true);
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，操作记录已保存，请返回后核对");
        let state;
        try {
          state = await client.operationStatus(intent.opID, "entry.rename");
        } catch (e) {
          if (
            !(e instanceof FileServiceError) ||
            e.code !== "OPERATION_NOT_FOUND"
          )
            throw e;
        }
        if (!state || state.state === "prepared")
          state = await client.rename(
            intent.opID,
            source,
            target,
            intent.version,
          );
        if (state.state === "conflict" || state.state === "failed") {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((i) => i.opID !== intent.opID));
          throw new Error(
            state.error?.message || "重命名未执行，请检查文件后重试",
          );
        }
        if (state.state !== "committed")
          throw new Error("重命名结果尚未确认，请稍后核对");
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("重命名已执行，请返回原工作区核对草稿");
        const moved = await moveDrafts(intent, source, target);
        const byOld = new Map(moved.map((m) => [documentKey(m.previous), m]));
        for (const doc of active) {
          const oldKey = documentKey(doc.identity),
            migration = byOld.get(oldKey);
          if (!migration || migration.previousToken !== doc.token) {
            doc.conflict = true;
            doc.persistenceError = "草稿在其他标签页发生变化，请先导出当前内容";
            continue;
          }
          docs.current.delete(oldKey);
          doc.identity = migration.identity;
          doc.path = migration.identity.path;
          doc.token = migration.token;
          doc.conflict = true;
          const newKey = documentKey(doc.identity);
          docs.current.set(newKey, doc);
          if (selections.current.get(intent.workspaceID) === oldKey)
            selections.current.set(intent.workspaceID, newKey);
          setSelected((old) => (old === oldKey ? newKey : old));
          try {
            const current = await client.readBytes(doc.path);
            const hasBOM =
              current.bytes.length >= 3 &&
              current.bytes[0] === 0xef &&
              current.bytes[1] === 0xbb &&
              current.bytes[2] === 0xbf;
            if (
              current.entry.version &&
              doc.encoding === (hasBOM ? "utf8-bom" : "utf8") &&
              new TextDecoder("utf-8", { fatal: true }).decode(
                current.bytes,
              ) === doc.base
            ) {
              doc.version = current.entry.version;
              doc.conflict = false;
            }
            await persist(doc);
          } catch (e) {
            doc.persistenceError =
              "重命名后草稿仍需核对：" + (e as Error).message;
          }
        }
        for (const [oldKey, item] of previews.current) {
          if (!sameScope(item.identity) || !matches(item.path)) continue;
          const nextPath = target + item.path.slice(source.length),
            nextIdentity = { ...item.identity, path: nextPath };
          try {
            const entry = await client.stat(nextPath);
            if (!entry.version) continue;
            previews.current.delete(oldKey);
            const nextKey = documentKey(nextIdentity);
            previews.current.set(nextKey, {
              ...item,
              identity: nextIdentity,
              path: nextPath,
              version: entry.version,
              size: entry.size,
            });
            if (selections.current.get(intent.workspaceID) === oldKey)
              selections.current.set(intent.workspaceID, nextKey);
            setSelected((old) => (old === oldKey ? nextKey : old));
          } catch {
            /* Keep the old tab available for an explicit refresh. */
          }
        }
        setExpanded(
          (old) =>
            new Set(
              Array.from(old, (p) =>
                matches(p) ? target + p.slice(source.length) : p,
              ),
            ),
        );
        setSelectedDirectory((old) =>
          matches(old) ? target + old.slice(source.length) : old,
        );
        setDirectories((old) => {
          const next: Record<string, Directory> = {};
          for (const [p, listing] of Object.entries(old))
            next[matches(p) ? target + p.slice(source.length) : p] = listing;
          return next;
        });
        await removeCreateIntent(intent.opID);
        setIntents((old) => old.filter((i) => i.opID !== intent.opID));
        update();
        if (clientRef.current === client && gen === generation.current) {
          try {
            for (const p of expanded)
              await loadDirectory(
                client,
                matches(p) ? target + p.slice(source.length) : p,
                gen,
              );
          } catch (e) {
            setError("重命名已完成，文件树刷新失败：" + (e as Error).message);
          }
        }
      } catch (e) {
        if (
          e instanceof FileServiceError &&
          [
            "ALREADY_EXISTS",
            "CONFLICT",
            "FILE_CHANGED",
            "SPECIAL_FILE",
          ].includes(e.code)
        ) {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((i) => i.opID !== intent.opID));
        }
        throw e;
      } finally {
        activeIntents.current.delete(intent.opID);
      }
    },
    [persist, expanded, loadDirectory, update],
  );
  const withRenameLock = useCallback(async (run: () => Promise<void>) => {
    if (renameLock.current) throw new Error("已有重命名正在进行");
    renameLock.current = true;
    setRenaming(true);
    try {
      await run();
    } finally {
      renameLock.current = false;
      setRenaming(false);
    }
  }, []);
  const renameItem = useCallback(
    async (
      source: string,
      name: string,
      expectedWorkspace: string,
      expectedRevision: number,
    ) =>
      withRenameLock(async () => {
        const client = clientRef.current,
          w = workspace,
          gen = generation.current;
        if (
          !client ||
          !w ||
          !terminal ||
          w.id !== expectedWorkspace ||
          w.root_revision !== expectedRevision ||
          !supportsRename
        )
          throw new Error("工作区已切换或节点尚未升级");
        if (transferAbort.current)
          throw new Error("请先完成或取消正在进行的文件传输");
        if (
          !name ||
          name === "." ||
          name === ".." ||
          /[\/\\\u0000-\u001f]/.test(name) ||
          new TextEncoder().encode(name).length > 255
        )
          throw new Error("名称无效，请输入单个文件名或文件夹名");
        const slash = source.lastIndexOf("/"),
          target = childPath(slash < 0 ? "." : source.slice(0, slash), name);
        if (source === target) throw new Error("名称没有改变");
        const overlap = (a: string, b: string) =>
          a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        if (
          intents.some((i) =>
            [i.path, i.source].some(
              (p) => !!p && (overlap(p, source) || overlap(p, target)),
            ),
          )
        )
          throw new Error("相关目录中有待确认文件操作，请先处理");
        const inScope = (id: DraftIdentity) =>
          id.account === account &&
          id.nodeID === terminal.node_id &&
          id.workspaceID === w.id &&
          id.rootRevision === w.root_revision;
        const targets =
          Array.from(docs.current.values()).some(
            (d) =>
              inScope(d.identity) &&
              (d.path === target || d.path.startsWith(target + "/")),
          ) ||
          Array.from(previews.current.values()).some(
            (p) =>
              inScope(p.identity) &&
              (p.path === target || p.path.startsWith(target + "/")),
          );
        if (targets) throw new Error("目标路径已有打开的标签，请先处理");
        for (const doc of docs.current.values()) {
          if (
            !inScope(doc.identity) ||
            !(doc.path === source || doc.path.startsWith(source + "/"))
          )
            continue;
          if (doc.saving || doc.pending)
            throw new Error("请先完成受影响文件的保存或结果核对");
          const oldKey = documentKey(doc.identity),
            timer = timers.current.get(oldKey);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(oldKey);
          }
          await persist(doc);
        }
        await moveDrafts(
          {
            account,
            nodeID: terminal.node_id,
            workspaceID: w.id,
            rootRevision: w.root_revision,
          },
          source,
          target,
          true,
        );
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，请重新选择文件");
        const meta = await client.stat(source);
        if (!meta.version || meta.restricted)
          throw new Error("源文件不支持重命名");
        const intent: CreateIntent = {
          account,
          nodeID: terminal.node_id,
          workspaceID: w.id,
          rootRevision: w.root_revision,
          rootPath: w.root_path,
          opID: client.newOperationID(),
          kind: "rename",
          path: target,
          source,
          version: meta.version,
          createdAt: Date.now(),
        };
        await recordCreateIntent(intent);
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，操作记录已保存，请返回后核对");
        setIntents((old) => [...old, intent]);
        await renameIntent(intent);
      }),
    [
      account,
      workspace,
      terminal?.id,
      terminal?.node_id,
      supportsRename,
      intents,
      persist,
      renameIntent,
      withRenameLock,
    ],
  );
  const retryRename = useCallback(
    (intent: CreateIntent) => withRenameLock(() => renameIntent(intent)),
    [renameIntent, withRenameLock],
  );
  const beginDelete = useCallback(
    async (
      path: string,
      recursive: boolean,
      expectedWorkspace: string,
      expectedRevision: number,
    ) => {
      let result: { intent: CreateIntent; preview: DeleteStatus } | undefined;
      await withRenameLock(async () => {
        const client = clientRef.current,
          w = workspace,
          gen = generation.current;
        if (
          !client ||
          !w ||
          !terminal ||
          !supportsDelete ||
          w.id !== expectedWorkspace ||
          w.root_revision !== expectedRevision
        )
          throw new Error("工作区已切换或节点尚未升级");
        if (transferAbort.current)
          throw new Error("请先完成或取消正在进行的文件传输");
        const overlap = (a: string, b: string) =>
          a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        if (
          intents.some((i) =>
            [i.path, i.source].some((p) => !!p && overlap(p, path)),
          )
        )
          throw new Error("相关目录中有待确认文件操作，请先处理");
        for (const doc of docs.current.values()) {
          if (
            doc.identity.account !== account ||
            doc.identity.nodeID !== terminal.node_id ||
            doc.identity.workspaceID !== w.id ||
            doc.identity.rootRevision !== w.root_revision ||
            !(doc.path === path || doc.path.startsWith(path + "/"))
          )
            continue;
          if (doc.saving || doc.pending)
            throw new Error("请先完成受影响文件的保存或结果核对");
          const key = documentKey(doc.identity),
            timer = timers.current.get(key);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(key);
          }
          await persist(doc);
        }
        const scope = {
          account,
          nodeID: terminal.node_id,
          workspaceID: w.id,
          rootRevision: w.root_revision,
        };
        await checkDeleteDrafts(scope, path);
        const meta = await client.stat(path);
        if (
          !meta.version ||
          meta.restricted ||
          (recursive ? meta.kind !== "directory" : meta.kind !== "file")
        )
          throw new Error("文件类型已改变，请刷新后重新选择");
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，请重新选择文件");
        const intent: CreateIntent = {
          ...scope,
          rootPath: w.root_path,
          opID: client.newOperationID(),
          kind: "delete",
          path,
          version: meta.version,
          recursive,
          confirmed: false,
          createdAt: Date.now(),
        };
        await recordCreateIntent(intent);
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，操作记录已保存，请返回后核对");
        setIntents((old) => [...old, intent]);
        try {
          const preview = await client.prepareDelete(
            intent.opID,
            path,
            meta.version,
            recursive,
          );
          if (
            preview.path !== path ||
            preview.recursive !== recursive ||
            preview.state !== "prepared"
          )
            throw new Error("节点返回的删除预览不匹配");
          result = { intent, preview };
        } catch (e) {
          if (
            e instanceof FileServiceError &&
            [
              "FILE_CHANGED",
              "SPECIAL_FILE",
              "MOUNT_BOUNDARY",
              "DELETE_LIMIT",
              "DIRECTORY_NOT_EMPTY",
              "UNSUPPORTED_FILESYSTEM",
              "NOT_FOUND",
            ].includes(e.code)
          ) {
            await removeCreateIntent(intent.opID);
            setIntents((old) => old.filter((i) => i.opID !== intent.opID));
          }
          throw e;
        }
      });
      return result!;
    },
    [
      workspace,
      terminal?.id,
      terminal?.node_id,
      supportsDelete,
      intents,
      account,
      persist,
      withRenameLock,
    ],
  );

  const inspectDelete = useCallback(
    async (intent: CreateIntent): Promise<DeleteStatus> => {
      const client = clientRef.current;
      if (
        !client ||
        intent.kind !== "delete" ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision ||
        !intent.version ||
        typeof intent.recursive !== "boolean"
      )
        throw new Error("工作区或删除记录无效");
      let status: DeleteStatus;
      try {
        status = await client.deleteStatus(intent.opID);
      } catch (e) {
        if (
          !(e instanceof FileServiceError) ||
          e.code !== "OPERATION_NOT_FOUND" ||
          intent.confirmed
        )
          throw e;
        status = await client.prepareDelete(
          intent.opID,
          intent.path,
          intent.version,
          intent.recursive,
        );
      }
      if (status.path !== intent.path || status.recursive !== intent.recursive)
        throw new Error("节点返回的删除范围不匹配");
      return status;
    },
    [],
  );

  const reconcileDelete = useCallback(
    async (intent: CreateIntent, status: DeleteStatus): Promise<void> => {
      const client = clientRef.current,
        gen = generation.current;
      if (
        !client ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision
      )
        throw new Error("工作区已切换，请返回后核对删除结果");
      if (status.path !== intent.path || status.count > 8192)
        throw new Error("删除结果与操作记录不匹配");
      const deleted: string[] = [],
        removedDirs: string[] = [];
      for (let offset = 0; offset < status.count; ) {
        const page = await client.deleteOutcomes(intent.opID, offset);
        if (!page.items.length || page.next > status.count)
          throw new Error("删除结果不完整，请稍后核对");
        for (const item of page.items)
          if (item.state === "deleted") {
            if (item.kind === "file") deleted.push(item.path);
            if (item.kind === "directory") removedDirs.push(item.path);
          }
        offset = page.next;
      }
      if (gen !== generation.current || clientRef.current !== client)
        throw new Error("工作区已切换，请返回后核对删除结果");
      const changes = await markDeletedDrafts(intent, deleted),
        byKey = new Map(changes.map((c) => [documentKey(c.identity), c]));
      if (gen !== generation.current || clientRef.current !== client)
        throw new Error("工作区已切换，草稿标记已保存，请返回后核对");
      const deletedSet = new Set(deleted);
      for (const [key, doc] of docs.current) {
        if (
          doc.identity.account !== intent.account ||
          doc.identity.nodeID !== intent.nodeID ||
          doc.identity.workspaceID !== intent.workspaceID ||
          doc.identity.rootRevision !== intent.rootRevision ||
          !deletedSet.has(doc.path)
        )
          continue;
        const change = byKey.get(key);
        if (!change || change.previousToken !== doc.token)
          doc.persistenceError = "草稿在其他标签页发生变化，请导出当前内容";
        else doc.token = change.token;
        doc.deleted = true;
        doc.conflict = true;
        doc.message = "文件已删除，草稿保留在当前浏览器。";
      }
      for (const [key, preview] of previews.current) {
        if (
          preview.identity.account === intent.account &&
          preview.identity.nodeID === intent.nodeID &&
          preview.identity.workspaceID === intent.workspaceID &&
          preview.identity.rootRevision === intent.rootRevision &&
          deletedSet.has(preview.path)
        ) {
          previews.current.delete(key);
          if (selections.current.get(intent.workspaceID) === key)
            selections.current.delete(intent.workspaceID);
          setSelected((old) => (old === key ? null : old));
        }
      }
      setDeletedDrafts(await listDeletedDrafts(intent));
      setRecoverableDrafts(await listRecoverableDrafts(intent));
      const removed = (p: string) =>
        removedDirs.some((dir) => p === dir || p.startsWith(dir + "/"));
      if (gen === generation.current && clientRef.current === client) {
        setExpanded(
          (old) => new Set(Array.from(old).filter((p) => !removed(p))),
        );
        setSelectedDirectory((old) => (removed(old) ? "." : old));
        setDirectories((old) => {
          const next: Record<string, Directory> = {};
          for (const [p, v] of Object.entries(old))
            if (!removed(p)) next[p] = v;
          return next;
        });
        for (const p of expanded)
          if (!removed(p)) await loadDirectory(client, p, gen).catch(() => {});
      }
      update();
    },
    [expanded, loadDirectory, update],
  );

  const flushDeleteDrafts = useCallback(
    async (intent: CreateIntent) => {
      for (const doc of docs.current.values())
        if (
          doc.identity.account === intent.account &&
          doc.identity.nodeID === intent.nodeID &&
          doc.identity.workspaceID === intent.workspaceID &&
          doc.identity.rootRevision === intent.rootRevision &&
          (doc.path === intent.path || doc.path.startsWith(intent.path + "/"))
        ) {
          if (doc.saving || doc.pending)
            throw new Error("请先完成受影响文件的保存或结果核对");
          const key = documentKey(doc.identity),
            timer = timers.current.get(key);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(key);
          }
          await persist(doc);
        }
      await checkDeleteDrafts(intent, intent.path);
    },
    [persist],
  );
  const executeDelete = useCallback(
    async (
      intent: CreateIntent,
      authorize: boolean,
    ): Promise<{ intent: CreateIntent; status: DeleteStatus }> => {
      let result: { intent: CreateIntent; status: DeleteStatus } | undefined;
      await withRenameLock(async () => {
        const client = clientRef.current;
        if (
          !client ||
          intent.kind !== "delete" ||
          !supportsDelete ||
          client.workspace.id !== intent.workspaceID ||
          client.workspace.root_revision !== intent.rootRevision
        )
          throw new Error("工作区已断开或节点尚未升级");
        if (transferAbort.current)
          throw new Error("请先完成或取消正在进行的文件传输");
        if (activeIntents.current.has(intent.opID))
          throw new Error("此删除正在进行");
        activeIntents.current.add(intent.opID);
        try {
          let status = await inspectDelete(intent);
          if (status.state !== "aborted") await flushDeleteDrafts(intent);
          if (authorize) {
            if (status.state !== "prepared")
              throw new Error("删除预览状态已改变，请重新核对");
            intent = await confirmDeleteIntent(intent.opID);
            setIntents((old) =>
              old.map((i) => (i.opID === intent.opID ? intent : i)),
            );
          }
          if (
            !intent.confirmed &&
            (status.state === "prepared" || status.state === "deleting")
          )
            throw new Error("请先确认删除范围");
          let attempts = 0;
          while (
            intent.confirmed &&
            (status.state === "prepared" || status.state === "deleting")
          ) {
            const previous = (status.deleted || 0) + (status.skipped || 0);
            status = await client.commitDelete(intent.opID);
            if (
              status.path !== intent.path ||
              status.recursive !== intent.recursive
            )
              throw new Error("删除结果与操作记录不匹配");
            if (
              ++attempts > Math.ceil(status.count / 32) + 2 ||
              (status.state === "deleting" &&
                (status.deleted || 0) + (status.skipped || 0) <= previous)
            )
              throw new Error("删除进度未推进，请稍后核对");
          }
          if (
            ["committed", "partial", "uncertain", "aborted"].includes(
              status.state,
            )
          ) {
            await reconcileDelete(intent, status);
            if (status.state === "committed" || status.state === "aborted") {
              await removeCreateIntent(intent.opID);
              setIntents((old) => old.filter((i) => i.opID !== intent.opID));
            }
          }
          result = { intent, status };
        } finally {
          activeIntents.current.delete(intent.opID);
        }
      });
      return result!;
    },
    [
      supportsDelete,
      inspectDelete,
      flushDeleteDrafts,
      reconcileDelete,
      withRenameLock,
    ],
  );

  const cancelDelete = useCallback(
    async (intent: CreateIntent): Promise<DeleteStatus> => {
      let result: DeleteStatus | undefined;
      await withRenameLock(async () => {
        const client = clientRef.current;
        if (
          !client ||
          intent.kind !== "delete" ||
          client.workspace.id !== intent.workspaceID ||
          client.workspace.root_revision !== intent.rootRevision
        )
          throw new Error("工作区已断开");
        if (activeIntents.current.has(intent.opID))
          throw new Error("删除正在执行，请等待当前批次完成");
        await flushDeleteDrafts(intent);
        const status = await client.cancelDelete(intent.opID);
        if (status.path !== intent.path) throw new Error("删除记录不匹配");
        const current = await client.deleteStatus(intent.opID);
        await reconcileDelete(intent, current);
        if (current.state === "aborted") {
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((i) => i.opID !== intent.opID));
        }
        result = current;
      });
      return result!;
    },
    [reconcileDelete, flushDeleteDrafts, withRenameLock],
  );
  const acknowledgeDelete = useCallback(
    async (intent: CreateIntent) => {
      await withRenameLock(async () => {
        const status = await inspectDelete(intent);
        if (status.state !== "partial")
          throw new Error("结果尚未完成或存在不确定项，不能移除记录");
        await flushDeleteDrafts(intent);
        await reconcileDelete(intent, status);
        await removeCreateIntent(intent.opID);
        setIntents((old) => old.filter((i) => i.opID !== intent.opID));
      });
    },
    [inspectDelete, flushDeleteDrafts, reconcileDelete, withRenameLock],
  );
  const deleteOutcomes = useCallback(
    async (
      intent: CreateIntent,
      offset: number,
    ): Promise<{ items: DeleteOutcome[]; next: number }> => {
      const client = clientRef.current;
      if (
        !client ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision
      )
        throw new Error("工作区已断开");
      return client.deleteOutcomes(intent.opID, offset);
    },
    [],
  );
  const runUploadFile = useCallback(
    async (
      file: File,
      parent: string,
      expectedWorkspace: string,
      expectedRevision: number,
      existing?: CreateIntent,
      signal?: AbortSignal,
    ) => {
      if (renameLock.current) throw new Error("重命名期间不能开始上传");
      const client = clientRef.current,
        w = workspace,
        gen = generation.current;
      if (
        !client ||
        !w ||
        !terminal ||
        w.id !== expectedWorkspace ||
        w.root_revision !== expectedRevision
      )
        throw new Error("工作区已改变，请重新选择文件");
      if (
        !file.name ||
        file.name === "." ||
        file.name === ".." ||
        /[\/\\\u0000-\u001f]/.test(file.name) ||
        new TextEncoder().encode(file.name).length > 255
      )
        throw new Error("文件名无效");
      let tx: UploadTransaction;
      if (existing) {
        if (
          existing.kind !== "upload" ||
          existing.workspaceID !== w.id ||
          existing.rootRevision !== w.root_revision ||
          !Number.isSafeInteger(existing.size) ||
          !existing.sha256 ||
          !/^[0-9a-f]{64}$/.test(existing.sha256)
        )
          throw new Error("上传记录无效，请检查目标文件");
        tx = {
          opID: existing.opID,
          spec: {
            path: existing.path,
            create: true,
            size: existing.size!,
            sha256: existing.sha256,
          },
          sourceName: existing.sourceName || file.name,
        };
      } else {
        setTransfer("正在校验本地文件");
        tx = await client.prepareUpload(
          childPath(parent, file.name),
          file,
          signal,
          (done, total) => setTransfer(`正在校验 ${done} / ${total} 字节`),
        );
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，请重新选择文件");
        const intent: CreateIntent = {
          account,
          nodeID: terminal.node_id,
          workspaceID: w.id,
          rootRevision: w.root_revision,
          rootPath: w.root_path,
          opID: tx.opID,
          kind: "upload",
          path: tx.spec.path,
          createdAt: Date.now(),
          size: tx.spec.size,
          sha256: tx.spec.sha256,
          sourceName: file.name,
        };
        await recordCreateIntent(intent);
        if (signal?.aborted) {
          await removeCreateIntent(intent.opID);
          throw new DOMException("已取消上传", "AbortError");
        }
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，上传记录已保存，请返回原工作区核对");
        setIntents((old) => [...old, intent]);
      }
      if (activeIntents.current.has(tx.opID)) throw new Error("此上传正在进行");
      activeIntents.current.add(tx.opID);
      let beginSent = false;
      try {
        const result = await client.upload(tx, file, {
          signal,
          onBegin: () => {
            beginSent = true;
          },
          onHash: (done, total) =>
            setTransfer(`正在校验 ${done} / ${total} 字节`),
          onProgress: (done, total) =>
            setTransfer(`正在上传 ${done} / ${total} 字节`),
        });
        if (result.state !== "committed") throw new Error("上传结果尚未确认");
        await removeCreateIntent(tx.opID);
        setIntents((old) => old.filter((item) => item.opID !== tx.opID));
        if (clientRef.current === client) await refresh();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          if (!existing && !beginSent) {
            await removeCreateIntent(tx.opID);
            setIntents((old) => old.filter((item) => item.opID !== tx.opID));
            throw e;
          }
          try {
            const state = await client.operationStatus(tx.opID);
            const result =
              state.state === "receiving" || state.state === "ready"
                ? await client.abortUpload(tx)
                : state;
            if (result.state === "committed" && !result.version)
              throw new Error("节点未返回文件版本，请稍后再次核对");
            if (
              result.state === "aborted" ||
              result.state === "committed" ||
              result.state === "failed" ||
              result.state === "conflict"
            ) {
              await removeCreateIntent(tx.opID);
              setIntents((old) => old.filter((item) => item.opID !== tx.opID));
              if (
                result.state === "committed" &&
                clientRef.current === client
              ) {
                await refresh();
                throw new Error("取消时上传已完成，目标文件已保存");
              }
              throw new DOMException("已取消上传", "AbortError");
            }
          } catch (cancelError) {
            if (
              (cancelError as Error).name === "AbortError" ||
              (cancelError as Error).message ===
                "取消时上传已完成，目标文件已保存"
            )
              throw cancelError;
          }
          throw new Error("取消结果尚未确认，请恢复连接后核对待处理操作");
        }
        if (
          e instanceof FileServiceError &&
          ["ALREADY_EXISTS", "CONFLICT"].includes(e.code)
        ) {
          await removeCreateIntent(tx.opID);
          setIntents((old) => old.filter((item) => item.opID !== tx.opID));
        }
        throw e;
      } finally {
        activeIntents.current.delete(tx.opID);
        setTransfer("");
      }
    },
    [account, workspace, terminal?.id, terminal?.node_id, refresh],
  );
  const uploadFile = useCallback(
    async (
      file: File,
      parent: string,
      expectedWorkspace: string,
      expectedRevision: number,
      existing?: CreateIntent,
    ) => {
      if (renameLock.current) throw new Error("重命名期间不能开始上传");
      if (transferAbort.current) throw new Error("已有文件传输正在进行");
      const controller = new AbortController();
      transferAbort.current = controller;
      try {
        await runUploadFile(
          file,
          parent,
          expectedWorkspace,
          expectedRevision,
          existing,
          controller.signal,
        );
      } finally {
        if (transferAbort.current === controller) transferAbort.current = null;
        setTransfer("");
      }
    },
    [runUploadFile],
  );
  const checkUploadIntent = useCallback(
    async (intent: CreateIntent, cancel = false) => {
      const client = clientRef.current;
      if (renameLock.current) throw new Error("重命名期间不能核对上传");
      if (
        !client ||
        client.workspace.id !== intent.workspaceID ||
        client.workspace.root_revision !== intent.rootRevision ||
        intent.kind !== "upload"
      )
        throw new Error("工作区已断开或目录已改变");
      if (activeIntents.current.has(intent.opID))
        throw new Error("此上传正在进行，请先取消传输");
      if (
        !Number.isSafeInteger(intent.size) ||
        intent.size! < 0 ||
        !intent.sha256 ||
        !/^[0-9a-f]{64}$/.test(intent.sha256)
      )
        throw new Error("上传记录无效，请检查目标文件");
      activeIntents.current.add(intent.opID);
      try {
        const status = await client.operationStatus(intent.opID);
        let result = status;
        if (
          cancel &&
          (status.state === "receiving" || status.state === "ready")
        ) {
          result = await client.abortUpload({
            opID: intent.opID,
            spec: {
              path: intent.path,
              size: intent.size!,
              sha256: intent.sha256,
              create: true,
            },
            sourceName: intent.sourceName || "",
          });
        }
        if (
          ["committed", "aborted", "failed", "conflict"].includes(result.state)
        ) {
          if (result.state === "committed" && !result.version)
            throw new Error("节点未返回文件版本，请稍后再次核对");
          await removeCreateIntent(intent.opID);
          setIntents((old) => old.filter((item) => item.opID !== intent.opID));
          if (result.state === "committed" && clientRef.current === client)
            await refresh();
          return result.state === "committed" ? "上传已完成" : "上传已终止";
        }
        if (result.state === "receiving" || result.state === "ready")
          return "请选择原文件继续上传，或取消此上传";
        return "节点尚无法确认上传结果，请稍后再次核对";
      } catch (e) {
        if (e instanceof FileServiceError && e.code === "OPERATION_NOT_FOUND")
          return "节点没有可查询的操作记录，请核对目标文件后重新选择原文件继续";
        throw e;
      } finally {
        activeIntents.current.delete(intent.opID);
      }
    },
    [refresh],
  );
  const createItem = useCallback(
    async (
      name: string,
      kind: "file" | "directory",
      parent: string,
      expectedWorkspace: string,
      expectedRevision: number,
    ) => {
      if (renameLock.current) throw new Error("重命名期间不能创建文件");
      const client = clientRef.current,
        w = workspace,
        gen = generation.current;
      if (!client || !w || !terminal) throw new Error("文件连接未就绪");
      if (w.id !== expectedWorkspace || w.root_revision !== expectedRevision)
        throw new Error("工作区已改变，请关闭对话框后重新选择目录");
      if (!supportsCreate) throw new Error("请先升级节点以启用文件创建");
      if (
        !name ||
        name === "." ||
        name === ".." ||
        /[\/\\\u0000-\u001f]/.test(name) ||
        new TextEncoder().encode(name).length > 255
      )
        throw new Error("名称无效，请输入单个文件名或文件夹名");
      const intent: CreateIntent = {
        account,
        nodeID: terminal.node_id,
        workspaceID: w.id,
        rootRevision: w.root_revision,
        rootPath: w.root_path,
        opID: client.newOperationID(),
        kind,
        path: childPath(parent, name),
        createdAt: Date.now(),
      };
      creatingItems.current++;
      try {
        await recordCreateIntent(intent); // durable before the node sees the request
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区已切换，操作已保存，请返回原工作区核对");
        setIntents((old) => [...old, intent]);
        await runCreateIntent(intent);
      } finally {
        creatingItems.current--;
      }
    },
    [
      account,
      workspace,
      terminal?.id,
      terminal?.node_id,
      runCreateIntent,
      supportsCreate,
    ],
  );
  const changeRoot = useCallback(
    async (
      target: string,
      expectedWorkspace: string,
      expectedRevision: number,
      expectedTerminal: string,
    ): Promise<"changed" | "pending"> => {
      if (renameLock.current) throw new Error("工作区正在处理其他操作");
      const w = workspace,
        client = clientRef.current,
        gen = generation.current;
      if (
        !w ||
        !terminal ||
        !client ||
        terminal.id !== expectedTerminal ||
        w.id !== expectedWorkspace ||
        w.root_revision !== expectedRevision ||
        client.workspace.id !== w.id ||
        client.workspace.root_revision !== w.root_revision
      )
        throw new Error("工作区已改变，请重新打开目录选择器");
      if (
        !target.startsWith("/") ||
        target.includes("\0") ||
        new TextEncoder().encode(target).length > 4096
      )
        throw new Error("请输入有效的绝对目录路径");
      if (target === w.root_path) throw new Error("请选择不同的目录");
      if (
        creatingItems.current ||
        activeIntents.current.size ||
        transferAbort.current ||
        restoringTabs.current
      )
        throw new Error("请先等待文件操作、传输和标签恢复结束");
      renameLock.current = true;
      setRenaming(true);
      let sent = false;
      const assertClean = () => {
        if (
          creatingItems.current ||
          activeIntents.current.size ||
          transferAbort.current ||
          restoringTabs.current
        )
          throw new Error("请先等待文件操作、传输和标签恢复结束");
        for (const [id, doc] of docs.current) {
          if (
            doc.identity.account !== account ||
            doc.identity.nodeID !== terminal.node_id ||
            doc.identity.workspaceID !== w.id ||
            doc.identity.rootRevision !== w.root_revision
          )
            continue;
          if (
            doc.text !== doc.base ||
            doc.pending ||
            doc.saving ||
            doc.closing ||
            doc.conflict ||
            doc.deleted ||
            doc.unavailable ||
            doc.manualSaveRequired ||
            doc.persistenceError ||
            queues.current.has(id)
          )
            throw new Error("请先保存或处理当前工作区的未保存草稿及待确认操作");
        }
      };
      try {
        assertClean();
        const scope = {
          account,
          nodeID: terminal.node_id,
          workspaceID: w.id,
          rootRevision: w.root_revision,
        };
        const [pending, deleted, drafts] = await Promise.all([
          listCreateIntents(scope),
          listDeletedDrafts(scope),
          listRecoverableDrafts(scope),
        ]);
        if (pending.length || deleted.length || drafts.length)
          throw new Error("当前工作区仍有本地草稿或待确认文件操作，请先处理");
        assertClean();
        if (gen !== generation.current || clientRef.current !== client)
          throw new Error("工作区连接已改变，请重新选择目录");
        sent = true;
        try {
          const result = await changeWorkspaceRoot(
            terminal.id,
            target,
            w.root_revision,
          );
          if (
            result.state !== "ready" ||
            result.workspace?.id !== w.id ||
            result.workspace.root_revision !== w.root_revision + 1
          )
            throw new Error("节点返回的目录切换状态无效");
          return "changed";
        } catch (error) {
          let state;
          try {
            state = await getWorkspace(terminal.id);
          } catch {
            throw new Error(
              "目录切换结果暂无法确认，工作区会自动重新连接并核对，请稍后查看",
            );
          }
          if (
            state.workspace?.id === w.id &&
            state.state === "ready" &&
            state.workspace.root_revision === w.root_revision + 1 &&
            state.workspace.root_path === target
          )
            return "changed";
          if (
            state.workspace?.id === w.id &&
            state.state === "changing" &&
            state.pending_target === target
          )
            return "pending";
          if (state.workspace?.id === w.id && state.state === "changing")
            throw new Error("工作区正在切换到其他目录，请稍后查看");
          if (
            state.workspace?.id === w.id &&
            state.workspace.root_revision !== w.root_revision
          )
            throw new Error("工作区已改变，请查看当前目录并重新选择");
          throw new Error(
            `目录切换未确认：${(error as Error).message}。请查看当前目录后重试`,
          );
        }
      } finally {
        renameLock.current = false;
        setRenaming(false);
        if (sent && gen === generation.current) {
          if (clientRef.current === client) clientRef.current = null;
          client.close();
          setReconnect((n) => n + 1);
        }
      }
    },
    [account, workspace, terminal?.id, terminal?.node_id],
  );
  const archivedRows = new Map<
    string,
    {
      identity: DraftIdentity;
      page: boolean;
      stored: boolean;
      pagePending: boolean;
      storedPending: boolean;
    }
  >();
  for (const item of archivedRecords) {
    const id = item.identity;
    if (
      workspace &&
      terminal &&
      id.account === account &&
      id.nodeID === terminal.node_id &&
      id.workspaceID === workspace.id &&
      id.rootRevision !== workspace.root_revision
    )
      archivedRows.set(documentKey(id), {
        identity: id,
        page: false,
        stored: true,
        pagePending: false,
        storedPending: item.pending,
      });
  }
  for (const doc of docs.current.values()) {
    if (
      !workspace ||
      !terminal ||
      doc.identity.account !== account ||
      doc.identity.nodeID !== terminal.node_id ||
      doc.identity.workspaceID !== workspace.id ||
      doc.identity.rootRevision === workspace.root_revision ||
      !(
        doc.text !== doc.base ||
        doc.pending ||
        doc.deleted ||
        doc.unavailable ||
        doc.manualSaveRequired ||
        doc.persistenceError
      )
    )
      continue;
    const key = documentKey(doc.identity),
      old = archivedRows.get(key);
    archivedRows.set(key, {
      identity: doc.identity,
      page: true,
      stored: old?.stored || false,
      pagePending: !!doc.pending,
      storedPending: old?.storedPending || false,
    });
  }
  return {
    workspace,
    connection,
    fileReady: connection === "中转连接" || connection === "WebRTC 直连",
    fileMetrics,
    error,
    directories,
    directoryFilters,
    filterDirectory,
    showHidden,
    changeShowHidden,
    expanded,
    selectedDirectory,
    selectDirectory: setSelectedDirectory,
    intents,
    renaming,
    supportsRename,
    supportsDelete,
    supportsArchive,
    archivedIntents: archivedIntents.filter(
      (i) =>
        workspace &&
        terminal &&
        i.account === account &&
        i.nodeID === terminal.node_id &&
        i.workspaceID === workspace.id &&
        i.rootRevision !== workspace.root_revision,
    ),
    archivedIntentsTruncated,
    inspectArchivedIntent,
    inspectArchivedSave,
    archivedDeleteOutcomes,
    forgetArchivedIntent,
    changeRoot,
    renameItem,
    retryRename,
    deletedDrafts,
    recoverableDrafts,
    archivedDrafts: Array.from(archivedRows.values()).sort(
      (a, b) =>
        b.identity.rootRevision - a.identity.rootRevision ||
        a.identity.path.localeCompare(b.identity.path),
    ),
    exportArchivedDraft,
    openDeletedDraft,
    openRecoverableDraft,
    saveDeletedAs,
    discardDeletedDraft,
    beginDelete,
    inspectDelete,
    executeDelete,
    cancelDelete,
    acknowledgeDelete,
    deleteOutcomes,
    transfer,
    downloadMessage,
    clearDownloadMessage: () => setDownloadMessage(""),
    clearTransfer: () => setTransfer(""),
    uploadFile,
    checkUploadIntent,
    cancelTransfer: () => {
      transferAbort.current?.abort();
      setTransfer("正在取消，请等待当前数据块确认");
    },
    download: (
      path: string,
      confirmRelayDownload?: (
        size: number,
        signal?: AbortSignal,
      ) => Promise<boolean>,
    ) => {
      const client = clientRef.current;
      if (renameLock.current)
        return Promise.reject(new Error("重命名期间不能开始下载"));
      if (!client) return Promise.reject(new Error("文件连接未就绪"));
      if (transferAbort.current)
        return Promise.reject(new Error("已有文件传输正在进行"));
      const controller = new AbortController();
      transferAbort.current = controller;
      setDownloadMessage("");
      setTransfer("正在准备下载");
      return downloadFile(
        client,
        path,
        controller.signal,
        (done, total) => setTransfer(`正在下载 ${done} / ${total} 字节`),
        () =>
          setDownloadMessage(
            "大文件下载已交给浏览器，通过服务器中转；请在浏览器下载列表查看进度或取消。",
          ),
        async (size, signal) =>
          !!confirmRelayDownload &&
          (await confirmRelayDownload(size, signal)) &&
          clientRef.current === client,
      ).finally(() => {
        if (transferAbort.current === controller) transferAbort.current = null;
        setTransfer("");
      });
    },
    createItem,
    supportsCreate,
    retryCreate: runCreateIntent,
    reportError: setError,
    selected,
    unrestoredTabs,
    forgetUnrestoredTabs: () => {
      if (pendingTabs.current?.scope !== tabScopeKey) return;
      pendingTabs.current.paths = [];
      pendingTabs.current.selected = null;
      setUnrestoredTabs([]);
      update();
    },
    document,
    preview,
    client: clientRef.current,
    documents: Array.from(docs.current.entries()).filter(
      ([, d]) =>
        d.identity.workspaceID === workspace?.id &&
        d.identity.rootRevision === workspace?.root_revision &&
        d.identity.account === account,
    ),
    previews: Array.from(previews.current.entries()).filter(
      ([, p]) =>
        p.identity.workspaceID === workspace?.id &&
        p.identity.rootRevision === workspace?.root_revision &&
        p.identity.account === account,
    ),
    refresh,
    toggle,
    openFile,
    edit,
    readConflict,
    acceptConflictBase,
    save,
    checkPendingSave,
    closeDocument,
    closePreview,
    retry,
    select: (id: string) => {
      tabInteraction.current++;
      if (workspace) selections.current.set(workspace.id, id);
      setSelected(id);
    },
    childPath,
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
