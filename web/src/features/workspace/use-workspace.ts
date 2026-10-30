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
  type CreateIntent,
  recordCreateIntent,
  listCreateIntents,
  removeCreateIntent,
  moveDrafts,
} from "../../services/files/drafts";
import type {
  FileEntry,
  SaveTransaction,
  UploadTransaction,
  Workspace,
} from "../../services/files/types";
import type { TerminalRecord } from "../../types";
import { downloadFile } from "../../services/files/download";
import { previewKind } from "./preview-utils";

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
export type BinaryPreview = {
  identity: DraftIdentity;
  path: string;
  kind: "image" | "pdf";
  version: string;
  size: number;
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
  supportsCreate: boolean,
  supportsRename: boolean,
) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [connection, setConnection] = useState("等待连接");
  const [error, setError] = useState("");
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState(".");
  const [intents, setIntents] = useState<CreateIntent[]>([]);
  const [transfer, setTransfer] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const clientRef = useRef<FileClient | null>(null),
    generation = useRef(0);
  const docs = useRef(new Map<string, Document>()),
    previews = useRef(new Map<string, BinaryPreview>()),
    selections = useRef(new Map<string, string>()),
    timers = useRef(new Map<string, number>()),
    queues = useRef(new Map<string, Promise<void>>());
  const activeIntents = useRef(new Set<string>());
  const transferAbort = useRef<AbortController | null>(null);
  const renameLock = useRef(false);
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
    setSelectedDirectory(".");
    setIntents([]);
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
        try {
          const pending = await listCreateIntents({
            account,
            nodeID: terminal.node_id,
            workspaceID: view.workspace.id,
            rootRevision: view.workspace.root_revision,
          });
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
    async (path: string) => {
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
      if (docs.current.has(key)) {
        selections.current.set(w.id, key);
        setSelected(key);
        return;
      }
      try {
        const kind = previewKind(path);
        if (kind) {
          const entry = await client.stat(path);
          if (gen !== generation.current) return;
          if (entry.kind !== "file" || !entry.version)
            throw new Error("文件无法预览");
          previews.current.set(key, {
            identity,
            path,
            kind,
            version: entry.version,
            size: entry.size,
          });
          selections.current.set(w.id, key);
          setSelected(key);
          update();
          return;
        }
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
  const save = useCallback(
    async (doc: Document) => {
      const client = clientRef.current;
      if (
        !client ||
        client.workspace.id !== doc.identity.workspaceID ||
        client.workspace.root_revision !== doc.identity.rootRevision ||
        doc.saving ||
        renameLock.current ||
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
  const runCreateIntent = useCallback(
    async (intent: CreateIntent) => {
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
        opID: client.newOperationID(),
        kind,
        path: childPath(parent, name),
        createdAt: Date.now(),
      };
      await recordCreateIntent(intent); // durable before the node sees the request
      if (gen !== generation.current || clientRef.current !== client)
        throw new Error("工作区已切换，操作已保存，请返回原工作区核对");
      setIntents((old) => [...old, intent]);
      await runCreateIntent(intent);
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
  return {
    workspace,
    connection,
    error,
    directories,
    expanded,
    selectedDirectory,
    selectDirectory: setSelectedDirectory,
    intents,
    renaming,
    supportsRename,
    renameItem,
    retryRename,
    transfer,
    clearTransfer: () => setTransfer(""),
    uploadFile,
    checkUploadIntent,
    cancelTransfer: () => {
      transferAbort.current?.abort();
      setTransfer("正在取消，请等待当前数据块确认");
    },
    download: (path: string) => {
      const client = clientRef.current;
      if (renameLock.current)
        return Promise.reject(new Error("重命名期间不能开始下载"));
      if (!client) return Promise.reject(new Error("文件连接未就绪"));
      if (transferAbort.current)
        return Promise.reject(new Error("已有文件传输正在进行"));
      const controller = new AbortController();
      transferAbort.current = controller;
      setTransfer("正在准备下载");
      return downloadFile(client, path, controller.signal, (done, total) =>
        setTransfer(`正在下载 ${done} / ${total} 字节`),
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
