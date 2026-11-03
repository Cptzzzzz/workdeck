import { migrateBrowserState } from "./services/browser-migration";
import { startTailnetProbe } from "./tailnet-probe";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  Command,
  Folder,
  LayoutGrid,
  KeyRound,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  PanelBottom,
  RotateCcw,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import type {
  ComputeNode as Node,
  TerminalRecord as Term,
  Snapshot,
  User,
  RenameTarget,
} from "./types";
import { api, setCSRF } from "./services/api";
import { TerminalView } from "./features/terminal/terminal-view";
import { HardwareDetails } from "./features/management/hardware-details";
import { formatBytes } from "./network-metrics";
import { codexStatus, isCodexTask } from "./codex-status";
import {
  useWorkspace,
  type Document as WorkspaceDocument,
} from "./features/workspace/use-workspace";
import {
  WorkspaceEditor,
  WorkspaceSidebar,
  CreateItemForm,
  RenameItemForm,
  DeleteItemForm,
  SaveDeletedAsForm,
  DiscardDeletedDraftForm,
  CloseDocumentForm,
  WorkspaceRootForm,
  ArchivedIntentForm,
  ArchivedSaveForm,
  PendingWritesForm,
} from "./features/workspace/workspace-view";
import type { CreateIntent, DraftIdentity } from "./services/files/drafts";
import {
  RenameForm,
  TerminateForm,
  CreateTerminal,
  NodeCodexSettings,
  JoinNode,
  Password,
} from "./features/management/forms";
import {
  SessionsPanel,
  NodesPanel,
  AccountPanel,
  SettingsPanel,
} from "./features/management/panels";
import {
  FONT_SIZE_KEY,
  parseFontSize,
  readFontSize,
  saveFontSize,
} from "./terminal-preferences";

type Modal =
  | "sessions"
  | "nodes"
  | "account"
  | "settings"
  | "create"
  | "create-codex"
  | "node-proxy"
  | "join"
  | "password"
  | "rename"
  | "terminate"
  | "file-create"
  | "file-rename"
  | "file-delete"
  | "file-save-as"
  | "file-discard-draft"
  | "file-close"
  | "workspace-root"
  | "archived-intent"
  | "archived-save"
  | "pending-writes"
  | null;
function layoutNumber(key: string, fallback: number, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
function timeAgo(raw: string) {
  if (!raw) return "尚未连接";
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(raw).getTime()) / 60000),
  );
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
  return `${Math.floor(m / 1440)} 天前`;
}
function status(t: Term, node?: Node) {
  if (t.desired_state === "closed" && t.state !== "closed")
    return { text: "等待终止", kind: "pending" };
  if (t.state === "closed") return { text: "已终止", kind: "muted" };
  if (!node?.online) return { text: "节点离线", kind: "muted" };
  const states: Record<string, { text: string; kind: string }> = {
    running: { text: "运行中", kind: "live" },
    creating: { text: "创建中", kind: "pending" },
    exited: { text: "已退出", kind: "muted" },
    lost: { text: "会话丢失", kind: "error" },
    error: { text: "启动失败", kind: "error" },
  };
  return states[t.state] || { text: t.state, kind: "muted" };
}
function RelayDownloadDialog({
  size,
  onClose,
}: {
  size: number;
  onClose: (allow: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(false);
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) || [],
        );
        if (!buttons.length) return;
        if (event.shiftKey && document.activeElement === buttons[0]) {
          event.preventDefault();
          buttons.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === buttons.at(-1)
        ) {
          event.preventDefault();
          buttons[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-shade"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose(false);
      }}
    >
      <section
        ref={panel}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="确认中转下载"
      >
        <h2>确认中转下载</h2>
        <p className="modal-description">
          当前浏览器无法直接流式保存此文件。下载 {formatBytes(size)}{" "}
          将经过主服务器，可能占用较多带宽；关闭页面后浏览器仍可能继续下载。
        </p>
        <div className="form-actions">
          <button className="secondary" onClick={() => onClose(false)}>
            取消
          </button>
          <button className="primary" onClick={() => onClose(true)}>
            使用中转下载
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [relayDownload, setRelayDownload] = useState<{
    size: number;
    done: (allow: boolean) => void;
  } | null>(null);
  const relayDownloadRef = useRef(relayDownload);
  relayDownloadRef.current = relayDownload;
  const confirmRelayDownload = useCallback(
    (size: number, signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        let settled = false;
        const aborted = () => done(false);
        const done = (allow: boolean) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", aborted);
          setRelayDownload((current) =>
            current?.done === done ? null : current,
          );
          resolve(allow);
        };
        setRelayDownload({ size, done });
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      }),
    [],
  );
  useEffect(() => () => relayDownloadRef.current?.done(false), []);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem("workdeck.editor.autoSave.v1") === "true";
    } catch {
      return false;
    }
  });
  const changeAutoSave = useCallback((enabled: boolean) => {
    setAutoSave(enabled);
    try {
      localStorage.setItem("workdeck.editor.autoSave.v1", String(enabled));
    } catch {}
  }, []);
  const changeFontSize = useCallback((size: number) => {
    setFontSize(size);
    saveFontSize(size);
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FONT_SIZE_KEY || event.key === null)
        setFontSize(parseFontSize(event.key === null ? null : event.newValue));
      if (event.key === "workdeck.editor.autoSave.v1" || event.key === null)
        setAutoSave(event.key !== null && event.newValue === "true");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  const [data, setData] = useState<Snapshot>({ nodes: [], terminals: [] });
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [showEnded, setShowEnded] = useState(false);
  const [modal, setModal] = useState<Modal>(null),
    [active, setActive] = useState<string | null>(null),
    [tabs, setTabs] = useState<string[]>([]);
  const [modalParent, setModalParent] = useState<Modal>(null);
  const [rootModalBusy, setRootModalBusy] = useState(false);
  const [archiveModalBusy, setArchiveModalBusy] = useState(false);
  const [pendingModalBusy, setPendingModalBusy] = useState(false);
  const [archivedIntent, setArchivedIntent] = useState<CreateIntent | null>(
    null,
  );
  const [archivedSave, setArchivedSave] = useState<{
    identity: DraftIdentity;
    source: "page" | "stored";
  } | null>(null);
  const [closeDocumentTarget, setCloseDocumentTarget] =
    useState<WorkspaceDocument | null>(null);
  const closeModal = () => {
    if (modal === "pending-writes" && pendingModalBusy) return;
    if (modal === "workspace-root" && rootModalBusy) return;
    if (
      (modal === "archived-intent" || modal === "archived-save") &&
      archiveModalBusy
    )
      return;
    if (
      modal === "file-close" &&
      (closeDocumentTarget?.saving || closeDocumentTarget?.closing)
    )
      return;
    setModal(modalParent);
    setModalParent(null);
  };
  const openChild = (child: Modal, parent: Modal) => {
    setModalParent(parent);
    setModal(child);
  };
  const [proxyNode, setProxyNode] = useState<Node | null>(null);
  const configureProxy = (node: Node, parent: Modal = null) => {
    setProxyNode(node);
    openChild("node-proxy", parent);
  };
  const modalElement = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!modal) {
      previousFocus.current?.focus();
      previousFocus.current = null;
      return;
    }
    if (!previousFocus.current && document.activeElement instanceof HTMLElement)
      previousFocus.current = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const root = modalElement.current;
      const target =
        root?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ||
        root?.querySelector<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled])",
        );
      target?.focus();
    });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (modal === "pending-writes" && pendingModalBusy) return;
        if (modal === "workspace-root" && rootModalBusy) return;
        if (
          (modal === "archived-intent" || modal === "archived-save") &&
          archiveModalBusy
        )
          return;
        if (
          modal === "file-close" &&
          (closeDocumentTarget?.saving || closeDocumentTarget?.closing)
        )
          return;
        setModal(modalParent);
        setModalParent(null);
      } else if (event.key === "Tab") {
        const focusable = Array.from(
          modalElement.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
          ) || [],
        ).filter((el) => el.getClientRects().length);
        if (!focusable.length) return;
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) {
          event.preventDefault();
          focusable.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          (index === -1 || index === focusable.length - 1)
        ) {
          event.preventDefault();
          focusable[0].focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keyboard);
    };
  }, [
    modal,
    modalParent,
    closeDocumentTarget?.saving,
    closeDocumentTarget?.closing,
    rootModalBusy,
    archiveModalBusy,
    pendingModalBusy,
  ]);
  const [mode, setMode] = useState<"terminal" | "workspace">(() => {
    try {
      return localStorage.getItem("workdeck.mode.v1") === "workspace"
        ? "workspace"
        : "terminal";
    } catch {
      return "terminal";
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    layoutNumber("workdeck.sidebar.v1", 280, 228, 600),
  );
  const [editorHeight, setEditorHeight] = useState(() =>
    layoutNumber("workdeck.editor-height.v1", 55, 20, 80),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [panelLayout, setPanelLayout] = useState<
    "split" | "editor" | "terminal"
  >("split");
  useEffect(() => {
    try {
      localStorage.setItem("workdeck.mode.v1", mode);
      localStorage.setItem("workdeck.sidebar.v1", String(sidebarWidth));
      localStorage.setItem("workdeck.editor-height.v1", String(editorHeight));
    } catch {}
  }, [mode, sidebarWidth, editorHeight]);
  const changeMode = async (next: "terminal" | "workspace") => {
    if (document.fullscreenElement)
      await document.exitFullscreen().catch(() => {});
    if (next === "workspace" && !active && tabs.length)
      setActive(tabs[tabs.length - 1]);
    setMode(next);
  };
  const workspace = useWorkspace(
    mode === "workspace",
    data.terminals.find((t) => t.id === active),
    user?.username || "",
    autoSave,
    !!data.nodes
      .find(
        (n) => n.id === data.terminals.find((t) => t.id === active)?.node_id,
      )
      ?.capabilities?.includes("workspace-create-v1"),
    !!data.nodes
      .find(
        (n) => n.id === data.terminals.find((t) => t.id === active)?.node_id,
      )
      ?.capabilities?.includes("workspace-rename-v1"),
    !!data.nodes
      .find(
        (n) => n.id === data.terminals.find((t) => t.id === active)?.node_id,
      )
      ?.capabilities?.includes("workspace-delete-v1"),
    !!data.nodes
      .find(
        (n) => n.id === data.terminals.find((t) => t.id === active)?.node_id,
      )
      ?.capabilities?.includes("workspace-watch-v1"),
    !!data.nodes
      .find(
        (n) => n.id === data.terminals.find((t) => t.id === active)?.node_id,
      )
      ?.capabilities?.includes("workspace-archive-v1"),
  );
  const [fileRenameTarget, setFileRenameTarget] = useState("");
  const [deletedSaveTarget, setDeletedSaveTarget] =
    useState<WorkspaceDocument | null>(null);
  const [fileDeleteTarget, setFileDeleteTarget] = useState<{
    path: string;
    directory: boolean;
    intent?: CreateIntent;
  }>({ path: "", directory: false });
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [terminationTarget, setTerminationTarget] = useState<Term | null>(null);
  const [menu, setMenu] = useState(false),
    [toast, setToast] = useState(""),
    [refreshError, setRefreshError] = useState("");
  const notify = useCallback((s: string) => setToast(s), []);
  const refresh = useCallback(async () => {
    try {
      setData(await api<Snapshot>("/state"));
      setRefreshError("");
    } catch (e) {
      setRefreshError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    return startTailnetProbe();
  }, [user]);
  useEffect(() => {
    api<User>("/me")
      .then((u) => {
        setCSRF(u.csrf);
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    const fn = () => {
      setCSRF("");
      setUser(null);
      setTabs([]);
      setActive(null);
    };
    window.addEventListener("workdeck:unauthorized", fn);
    return () => window.removeEventListener("workdeck:unauthorized", fn);
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const t = setInterval(refresh, 5000);
    const events = new EventSource("/api/events");
    events.addEventListener("state", refresh);
    return () => {
      clearInterval(t);
      events.close();
    };
  }, [user, refresh]);
  const pendingTerminalLink = useRef(
    new URL(window.location.href).searchParams.get("terminal"),
  );
  useEffect(() => {
    const id = pendingTerminalLink.current;
    if (!user || !id || !data.terminals.some((terminal) => terminal.id === id))
      return;
    pendingTerminalLink.current = null;
    setTabs((old) => (old.includes(id) ? old : [...old, id]));
    setActive(id);
    setMode("terminal");
    const url = new URL(window.location.href);
    url.searchParams.delete("terminal");
    window.history.replaceState(null, "", url);
  }, [user, data.terminals]);
  const knownCodexTurns = useRef<Map<string, string> | null>(null);
  const knownCodexEvents = useRef<Map<string, string> | null>(null);
  const codexSnapshot = useRef(data);
  codexSnapshot.current = data;
  const currentUser = useRef(user);
  currentUser.current = user;
  const [unreadCodex, setUnreadCodex] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!user) {
      knownCodexTurns.current = null;
      knownCodexEvents.current = null;
      return;
    }
    if (!data.nodes.length) return;
    const previous = knownCodexTurns.current;
    const previousEvents = knownCodexEvents.current;
    const current = new Map(
      data.terminals.map((terminal) => [
        terminal.id,
        terminal.task?.codex_turn || "",
      ]),
    );
    if (previous) {
      for (const terminal of data.terminals) {
        const turn = terminal.task?.codex_turn;
        if (
          !turn ||
          terminal.task?.codex_status ||
          !previous.has(terminal.id) ||
          previous.get(terminal.id) === turn
        )
          continue;
        const key = `workdeck-notified-${terminal.id}`;
        if (
          localStorage.getItem("workdeck-task-notifications") === "on" &&
          "Notification" in window &&
          Notification.permission === "granted" &&
          localStorage.getItem(key) !== turn
        ) {
          localStorage.setItem(key, turn);
          const notice = new Notification("Codex 本轮已结束", {
            body: `${terminal.name}：请查看结果和后续操作。`,
          });
          notice.onclick = () => {
            window.focus();
            setTabs((tabs) =>
              tabs.includes(terminal.id) ? tabs : [...tabs, terminal.id],
            );
            setActive(terminal.id);
            notice.close();
          };
        }
      }
    }
    if (previousEvents) {
      for (const terminal of data.terminals) {
        const event = terminal.task?.codex_event;
        const state = terminal.task?.codex_status;
        if (
          !event ||
          !previousEvents.has(terminal.id) ||
          previousEvents.get(terminal.id) === event ||
          ![
            "attention",
            "turn_ended",
            "interrupted",
            "goal_complete",
            "goal_blocked",
            "goal_paused",
            "goal_budget_limited",
            "goal_usage_limited",
          ].includes(state || "")
        )
          continue;
        if (active !== terminal.id || !document.hasFocus())
          setUnreadCodex((old) => ({ ...old, [terminal.id]: event }));
        if (state === "turn_ended" || state === "goal_complete") {
          window.setTimeout(() => {
            if (!currentUser.current) return;
            const latest = codexSnapshot.current.terminals.find(
              (item) => item.id === terminal.id,
            );
            if (
              latest?.task?.codex_event !== event ||
              latest.task.codex_status !== state
            )
              return;
            if (
              localStorage.getItem("workdeck-task-notifications") !== "on" ||
              !("Notification" in window) ||
              Notification.permission !== "granted"
            )
              return;
            const key = `workdeck-notified-event-${terminal.id}`;
            const identity =
              state === "goal_complete"
                ? `goal:${terminal.task?.codex?.thread_id}:${terminal.task?.codex?.goal?.created_at}:complete`
                : `turn:${terminal.task?.codex_turn || event}`;
            if (localStorage.getItem(key) === identity) return;
            localStorage.setItem(key, identity);
            const notice = new Notification(
              state === "goal_complete"
                ? "Codex Goal 已完成"
                : terminal.task?.codex?.managed
                  ? "Codex 本轮已结束"
                  : "Codex 可能已完成，请查看",
              {
                body: `${terminal.name}：请查看结果和后续操作。`,
              },
            );
            notice.onclick = () => {
              window.focus();
              setTabs((tabs) =>
                tabs.includes(terminal.id) ? tabs : [...tabs, terminal.id],
              );
              setActive(terminal.id);
              notice.close();
            };
          }, 2500);
        }
        if (
          [
            "attention",
            "goal_blocked",
            "goal_paused",
            "goal_budget_limited",
            "goal_usage_limited",
          ].includes(state || "") &&
          localStorage.getItem("workdeck-task-notifications") === "on" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          const key = `workdeck-notified-event-${terminal.id}`;
          const identity = state?.startsWith("goal_")
            ? `goal:${terminal.task?.codex?.thread_id}:${terminal.task?.codex?.goal?.created_at}:${state}`
            : event;
          if (localStorage.getItem(key) !== identity) {
            localStorage.setItem(key, identity);
            const notice = new Notification(
              state?.startsWith("goal_")
                ? "Codex Goal 需要处理"
                : "Codex 可能需要处理",
              {
                body: `${terminal.name}：请打开终端查看。`,
              },
            );
            notice.onclick = () => {
              window.focus();
              setTabs((tabs) =>
                tabs.includes(terminal.id) ? tabs : [...tabs, terminal.id],
              );
              setActive(terminal.id);
              notice.close();
            };
          }
        }
      }
    }
    knownCodexTurns.current = current;
    knownCodexEvents.current = new Map(
      data.terminals.map((terminal) => [
        terminal.id,
        terminal.task?.codex_event || "",
      ]),
    );
  }, [user, data, active]);
  useEffect(() => {
    const markRead = () => {
      if (!active || !document.hasFocus()) return;
      setUnreadCodex((old) => {
        if (!old[active]) return old;
        const next = { ...old };
        delete next[active];
        return next;
      });
    };
    markRead();
    window.addEventListener("focus", markRead);
    return () => window.removeEventListener("focus", markRead);
  }, [active]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const open = (id: string) => {
    setTabs((a) => (a.includes(id) ? a : [...a, id]));
    setActive(id);
    setMenu(false);
  };
  const closeTab = (id: string) => {
    const next = tabs.filter((t) => t !== id);
    setTabs(next);
    if (active === id) setActive(next.at(-1) || null);
  };
  const stop = async (terminal: Term) => {
    if (document.fullscreenElement)
      await document.exitFullscreen().catch(() => {});
    setTerminationTarget(terminal);
    setModal("terminate");
  };
  const recreate = async (t: Term) => {
    if (
      !confirm(
        `为「${t.name}」在原目录创建新的 Shell？原记录会保留，之前的命令不会自动重跑。`,
      )
    )
      return;
    try {
      const created = await api<Term>("/terminals", {
        method: "POST",
        body: JSON.stringify({
          node_id: t.node_id,
          name: t.name.slice(0, 24) + " · 重建",
          cwd: t.cwd,
        }),
      });
      await refresh();
      if (created.state === "error") {
        notify(created.error || "重新创建失败");
        return;
      }
      open(created.id);
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const rename = (terminal: Term) => {
    setRenameTarget({ kind: "terminal", id: terminal.id, name: terminal.name });
    setModal("rename");
  };
  const renameNode = (node: Node) => {
    setRenameTarget({ kind: "node", id: node.id, name: node.name });
    setModal("rename");
  };
  const revoke = async (n: Node) => {
    if (
      !confirm(
        `撤销节点「${n.name}」的接入身份？已有任务仍会留在节点上，但将无法通过此平台连接。`,
      )
    )
      return;
    try {
      await api("/nodes/" + n.id, { method: "DELETE" });
      setFilter("all");
      await refresh();
      notify("节点接入身份已撤销");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <span>正在连接工作台…</span>
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setCSRF(u.csrf);
          setUser(u);
        }}
      />
    );
  const selected = data.nodes.find((n) => n.id === filter);
  const current = data.terminals.find((t) => t.id === active);
  const online = data.nodes.filter((n) => n.online).length;
  const live = data.terminals.filter(
    (t) => t.state === "running" && t.desired_state !== "closed",
  );
  const visible = data.terminals.filter(
    (t) =>
      (filter === "all" || t.node_id === filter) &&
      (showEnded || t.state !== "closed") &&
      (
        t.name +
        " " +
        t.cwd +
        " " +
        (data.nodes.find((n) => n.id === t.node_id)?.name || "")
      )
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div
      className={"app " + (mode === "workspace" ? "workbench-mode" : "")}
      style={
        {
          "--workbench-sidebar-width":
            sidebarCollapsed && mode === "workspace"
              ? "0px"
              : `min(${sidebarWidth}px, max(228px, calc(100vw - 340px)))`,
          "--workbench-editor-height": `${editorHeight}%`,
        } as React.CSSProperties
      }
    >
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside
        className={
          "sidebar " +
          (menu ? "shown " : "") +
          (mode === "workspace" && sidebarCollapsed
            ? "workbench-sidebar-collapsed"
            : "")
        }
      >
        <div className={mode === "workspace" ? "hidden" : "legacy-sidebar"}>
          <Brand />
          <div className="workspace-label">PERSONAL WORKSPACE</div>
          <button
            className={"nav-item " + (filter === "all" ? "selected" : "")}
            onClick={() => {
              setFilter("all");
              setActive(null);
              setMenu(false);
            }}
          >
            <LayoutGrid size={18} />
            全部终端<span className="count">{live.length}</span>
          </button>
          <div className="nav-section">
            <span>计算节点</span>
            <button
              title="接入节点"
              aria-label="接入节点"
              onClick={() => setModal("join")}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="node-list">
            {data.nodes.map((n) => (
              <button
                key={n.id}
                className={
                  "nav-item node-item " + (filter === n.id ? "selected" : "")
                }
                onClick={() => {
                  setFilter(n.id);
                  setActive(null);
                  setMenu(false);
                }}
              >
                <Server size={17} />
                <span className="node-name">
                  {n.name}
                  <small>
                    {n.platform || "等待首次连接"}
                    {n.run_user ? " · " + n.run_user : ""}
                  </small>
                </span>
                <i className={"dot " + (n.online ? "online" : "")} />
              </button>
            ))}
            {!data.nodes.length && (
              <div className="sidebar-empty">
                接入第一台机器，
                <br />
                随时回到你的工作现场。
              </div>
            )}
          </div>
          <button className="add-node" onClick={() => setModal("join")}>
            <Plus size={16} />
            接入新节点
          </button>
          <div className="sidebar-bottom">
            <button
              className="sidebar-mode-button"
              onClick={() => void changeMode("workspace")}
            >
              工作区模式
            </button>
            <div className="secure-note">
              <ShieldCheck size={16} />
              <span>加密连接 · 会话独立运行</span>
            </div>
            <div className="profile">
              <div className="avatar">{user.username[0]?.toUpperCase()}</div>
              <div>
                <b>{user.username}</b>
                <small>个人工作台</small>
              </div>
              <button
                title="设置"
                aria-label="设置"
                onClick={() => setModal("settings")}
              >
                <Settings2 size={17} />
              </button>
              <button
                title="修改密码"
                aria-label="修改密码"
                onClick={() => setModal("password")}
              >
                <KeyRound size={17} />
              </button>
              <button
                title="退出此设备"
                aria-label="退出此设备"
                onClick={async () => {
                  try {
                    await api("/logout", { method: "POST" });
                    setUser(null);
                    setTabs([]);
                    setActive(null);
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </div>
        {mode === "workspace" && (
          <WorkspaceSidebar
            controller={workspace}
            onConfirmRelayDownload={confirmRelayDownload}
            supportsPending={
              !!data.nodes
                .find((n) => n.id === current?.node_id)
                ?.capabilities?.includes("workspace-pending-v1")
            }
            onSwitchMode={() => void changeMode("terminal")}
            onPendingWrites={() => setModal("pending-writes")}
            onNewItem={() => setModal("file-create")}
            onChangeRoot={() => setModal("workspace-root")}
            onArchivedIntent={(intent) => {
              setArchivedIntent(intent);
              setModal("archived-intent");
            }}
            onArchivedSave={(identity, source) => {
              setArchivedSave({ identity, source });
              setModal("archived-save");
            }}
            onRename={(path) => {
              setFileRenameTarget(path);
              setModal("file-rename");
            }}
            onDelete={(path, directory, intent) => {
              setFileDeleteTarget({ path, directory, intent });
              setModal("file-delete");
            }}
            onSessions={() => setModal("sessions")}
            onNodes={() => setModal("nodes")}
            onAccount={() => setModal("account")}
            onSettings={() => setModal("settings")}
          />
        )}
      </aside>
      {mode === "workspace" && !sidebarCollapsed && (
        <div
          className="workbench-sidebar-grip"
          role="separator"
          aria-label="调整文件树宽度"
          aria-orientation="vertical"
          aria-valuemin={228}
          aria-valuemax={Math.max(228, Math.min(600, window.innerWidth - 340))}
          aria-valuenow={Math.round(
            Math.max(228, Math.min(sidebarWidth, window.innerWidth - 340)),
          )}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setSidebarWidth((width) =>
              Math.max(
                228,
                Math.min(
                  600,
                  window.innerWidth - 340,
                  width + (event.key === "ArrowLeft" ? -10 : 10),
                ),
              ),
            );
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setSidebarWidth(
                Math.max(
                  228,
                  Math.min(
                    600,
                    Math.max(228, window.innerWidth - 340),
                    event.clientX,
                  ),
                ),
              );
          }}
          onPointerUp={() =>
            window.dispatchEvent(new Event("workdeck:resize-end"))
          }
          onPointerCancel={() =>
            window.dispatchEvent(new Event("workdeck:resize-end"))
          }
        />
      )}
      <main>
        <header className={"topbar " + (mode === "workspace" ? "hidden" : "")}>
          <button
            className="mobile-menu icon-button"
            aria-label="打开导航"
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <span>工作空间</span>
            <span>/</span>
            <b>{active ? "终端" : selected?.name || "全部终端"}</b>
          </div>
          <div className="topbar-right">
            <span className="connection-status">
              <i className={"dot " + (!refreshError ? "online" : "")} />
              {refreshError ? "连接中断" : "工作台已连接"}
            </span>
            <button
              className="icon-button"
              title="刷新状态"
              aria-label="刷新状态"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {mode === "terminal" && tabs.length > 0 && (
          <div className="tab-strip">
            <button
              className={"overview-tab " + (!active ? "active" : "")}
              onClick={() => setActive(null)}
            >
              <LayoutGrid size={15} />
              概览
            </button>
            {tabs.map((id) => {
              const t = data.terminals.find((t) => t.id === id);
              return (
                <div
                  key={id}
                  className={"terminal-tab " + (active === id ? "active" : "")}
                >
                  <button onClick={() => setActive(id)}>
                    {isCodexTask(t) ? (
                      <Command size={15} aria-label="Codex 任务" />
                    ) : (
                      <TerminalSquare size={15} aria-label="普通终端" />
                    )}
                    <span>{t?.name || "终端"}</span>
                    {t &&
                      (() => {
                        const state = codexStatus(
                          t,
                          data.nodes.find((n) => n.id === t.node_id),
                        );
                        return state ? (
                          <span
                            className={`codex-tab-indicator ${state.kind}`}
                            title={state.text}
                            aria-label={state.text}
                          />
                        ) : null;
                      })()}
                    {unreadCodex[id] && (
                      <span
                        className="codex-unread"
                        title="有未查看的 Codex 状态更新"
                        aria-label="有未查看的 Codex 状态更新"
                      />
                    )}
                  </button>
                  <button
                    title="断开此标签页，任务继续运行"
                    aria-label="关闭标签页"
                    onClick={() => closeTab(id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            <button
              className="new-tab"
              title="新建 Codex"
              aria-label="新建 Codex"
              onClick={() => setModal("create-codex")}
            >
              <Command size={16} />
            </button>
            <button
              className="new-tab"
              title="新建终端"
              onClick={() => setModal("create")}
            >
              <Plus size={17} />
            </button>
          </div>
        )}
        {refreshError && (
          <div className="global-error">
            无法刷新状态：{refreshError}。任务在节点上独立运行，正在重试连接。
          </div>
        )}
        <div
          className={
            "overview " + (active || mode === "workspace" ? "hidden" : "")
          }
        >
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR WORK, ALWAYS THERE</div>
              <h1>
                {selected ? selected.name : "你的远程工作台"}
                <span className="heading-dot">.</span>
              </h1>
              <p>连接任意机器，接着上次的工作继续。</p>
            </div>
            <div className="page-heading-actions">
              {selected && (
                <button
                  className="secondary"
                  onClick={() => configureProxy(selected)}
                >
                  <Settings2 size={16} />
                  代理设置
                </button>
              )}
              <button
                className="primary"
                onClick={() => setModal("create")}
                disabled={!online}
              >
                <Plus size={17} />
                新建终端
              </button>
              <button
                className="secondary codex-create-button"
                onClick={() => setModal("create-codex")}
                disabled={!online}
              >
                <Command size={17} />
                新建 Codex
              </button>
            </div>
          </div>
          <div className="stats">
            <div className="stat">
              <span>
                <Server size={16} />
                在线节点
              </span>
              <div>
                {online}
                <small>/ {data.nodes.length}</small>
              </div>
            </div>
            <div className="stat">
              <span>
                <TerminalSquare size={16} />
                运行中的终端
              </span>
              <div>
                {live.length}
                <small>个会话</small>
              </div>
            </div>
            <div className="stat stat-note">
              <span>
                <Radio size={16} />
                随时离开，随时回来
              </span>
              <p>关闭浏览器后，任务仍在原机器上运行。</p>
            </div>
          </div>
          {selected && (
            <div className="node-detail">
              <span>
                <i className={"dot " + (selected.online ? "online" : "")} />
                {selected.online
                  ? "在线"
                  : "离线 · 最后连接 " + timeAgo(selected.last_seen)}
              </span>
              <span>{selected.hostname}</span>
              <span>{selected.platform}</span>
              {selected.run_user && <span>运行用户：{selected.run_user}</span>}
              <div className="node-actions">
                <button
                  aria-label="重命名节点"
                  onClick={() => void renameNode(selected)}
                >
                  重命名
                </button>
                <button onClick={() => void revoke(selected)}>撤销接入</button>
              </div>
            </div>
          )}
          {selected && <HardwareDetails node={selected} initiallyOpen />}
          <div className="list-toolbar">
            <div className="section-label">
              终端会话 <span>{visible.length}</span>
            </div>
            <div className="list-controls">
              <label className="search">
                <Search size={15} />
                <input
                  aria-label="搜索终端"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索终端或目录"
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showEnded}
                  onChange={(e) => setShowEnded(e.target.checked)}
                />
                显示已结束
              </label>
            </div>
          </div>
          {visible.length ? (
            <div className="terminal-grid">
              {visible.map((t) => {
                const n = data.nodes.find((n) => n.id === t.node_id);
                const s = status(t, n);
                const attachable =
                  n?.online &&
                  ["running", "exited", "creating"].includes(t.state) &&
                  t.desired_state !== "closed";
                return (
                  <article className="terminal-card" key={t.id}>
                    <div className="card-top">
                      <span className="terminal-icon">
                        {isCodexTask(t) ? (
                          <Command size={21} />
                        ) : (
                          <TerminalSquare size={21} />
                        )}
                      </span>
                      <span
                        className={
                          "terminal-kind " + (isCodexTask(t) ? "codex" : "")
                        }
                      >
                        {isCodexTask(t) ? "Codex 任务" : "普通终端"}
                      </span>
                      <span className={"badge " + s.kind}>
                        <i />
                        {s.text}
                      </span>
                      <details className="card-menu">
                        <summary aria-label="终端操作">
                          <MoreHorizontal size={19} />
                        </summary>
                        <div>
                          <button onClick={() => void rename(t)}>重命名</button>
                          {n?.online &&
                            t.desired_state !== "closed" &&
                            ["lost", "error", "exited"].includes(t.state) && (
                              <button onClick={() => void recreate(t)}>
                                重新创建
                              </button>
                            )}
                          {t.desired_state !== "closed" && (
                            <button
                              className="danger-text"
                              onClick={() => void stop(t)}
                            >
                              终止终端
                            </button>
                          )}
                        </div>
                      </details>
                    </div>
                    <h3>
                      <button disabled={!attachable} onClick={() => open(t.id)}>
                        {t.name}
                      </button>
                    </h3>
                    <div className="card-node">
                      <Server size={13} />
                      {n?.name || "已撤销节点"}
                    </div>
                    {codexStatus(t, n) && (
                      <div
                        className={`codex-card-status ${codexStatus(t, n)!.kind}`}
                      >
                        {codexStatus(t, n)!.text}
                      </div>
                    )}
                    <div className="card-path">
                      <Folder size={14} />
                      <span title={t.cwd}>
                        {n?.home && t.cwd.startsWith(n.home)
                          ? "~" + t.cwd.slice(n.home.length)
                          : t.cwd}
                      </span>
                    </div>
                    {t.error && <p className="card-error">{t.error}</p>}
                    <div className="card-footer">
                      <span>
                        {t.viewers
                          ? `${t.viewers} 个连接`
                          : "创建于 " + timeAgo(t.created_at)}
                      </span>
                      {!attachable &&
                      ["lost", "error"].includes(t.state) &&
                      t.desired_state !== "closed" ? (
                        <button
                          disabled={!n?.online}
                          onClick={() => void recreate(t)}
                        >
                          重新创建
                          <ArrowRight size={15} />
                        </button>
                      ) : (
                        <button
                          disabled={!attachable}
                          onClick={() => open(t.id)}
                        >
                          {t.state === "exited" ? "查看终端" : "进入终端"}
                          <ArrowRight size={15} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              <button
                className="create-card"
                onClick={() => setModal("create")}
                disabled={!online}
              >
                <span>
                  <Plus size={22} />
                </span>
                <b>开启新的工作</b>
                <small>在任意在线节点创建终端</small>
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <div>
                <TerminalSquare size={33} />
              </div>
              <h2>{query ? "没有找到对应的终端" : "下一项工作，从这里开始"}</h2>
              <p>
                {!data.nodes.length
                  ? "接入一台机器，即可在浏览器中创建持久终端。"
                  : !online
                    ? "节点上线后，就可以创建或重新连接终端。"
                    : "创建一个终端。即使离开页面，工作也会继续。"}
              </p>
              <button
                className="primary"
                onClick={() => setModal(data.nodes.length ? "create" : "join")}
                disabled={!!data.nodes.length && !online}
              >
                <Plus size={16} />
                {data.nodes.length ? "新建终端" : "接入第一台节点"}
              </button>
            </div>
          )}
          <footer className="page-footer">
            <span>WORKDECK</span>
            <span>终端在节点运行 · 浏览器仅负责连接</span>
            <span>v0.1</span>
          </footer>
        </div>
        <div
          className={
            "sessions-host " + (!active && mode !== "workspace" ? "hidden" : "")
          }
          data-workbench-panel={mode === "workspace" ? panelLayout : undefined}
        >
          {mode === "workspace" && (
            <WorkspaceEditor
              onConfirmRelayDownload={confirmRelayDownload}
              layoutActions={
                <div
                  className="workbench-layout-actions"
                  aria-label="工作区布局"
                >
                  <button
                    className="icon-button"
                    aria-label={sidebarCollapsed ? "显示文件树" : "隐藏文件树"}
                    title={sidebarCollapsed ? "显示文件树" : "隐藏文件树"}
                    onClick={() => setSidebarCollapsed((value) => !value)}
                  >
                    {sidebarCollapsed ? (
                      <PanelLeftOpen size={16} />
                    ) : (
                      <PanelLeftClose size={16} />
                    )}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={
                      panelLayout === "editor"
                        ? "恢复编辑区和终端分栏"
                        : "最大化编辑区"
                    }
                    title={
                      panelLayout === "editor" ? "恢复分栏" : "最大化编辑区"
                    }
                    aria-pressed={panelLayout === "editor"}
                    disabled={!active}
                    onClick={() =>
                      setPanelLayout((value) =>
                        value === "editor" ? "split" : "editor",
                      )
                    }
                  >
                    <PanelTop size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={
                      panelLayout === "terminal"
                        ? "恢复终端和编辑区分栏"
                        : "最大化终端"
                    }
                    title={
                      panelLayout === "terminal" ? "恢复分栏" : "最大化终端"
                    }
                    aria-pressed={panelLayout === "terminal"}
                    disabled={!active}
                    onClick={() =>
                      setPanelLayout((value) =>
                        value === "terminal" ? "split" : "terminal",
                      )
                    }
                  >
                    <PanelBottom size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="恢复默认布局"
                    title="恢复默认布局"
                    onClick={() => {
                      setSidebarWidth(280);
                      setEditorHeight(55);
                      setSidebarCollapsed(false);
                      setPanelLayout("split");
                    }}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              }
              controller={workspace}
              onCloseDocument={(doc) => {
                if (
                  doc.text === doc.base &&
                  !doc.pending &&
                  !doc.conflict &&
                  !doc.deleted &&
                  !doc.unavailable &&
                  !doc.persistenceError &&
                  !doc.saving
                )
                  void workspace
                    .closeDocument(doc, "clean")
                    .catch((e) => notify((e as Error).message));
                else {
                  setCloseDocumentTarget(doc);
                  setModal("file-close");
                }
              }}
              onSaveDeletedAs={(doc) => {
                setDeletedSaveTarget(doc);
                setModal("file-save-as");
              }}
              onDiscardDeleted={(doc) => {
                setDeletedSaveTarget(doc);
                setModal("file-discard-draft");
              }}
            />
          )}
          {mode === "workspace" && active && (
            <div
              className="workbench-height-grip"
              role="separator"
              aria-label="调整编辑器和终端高度"
              aria-orientation="horizontal"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(editorHeight)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                  return;
                event.preventDefault();
                setEditorHeight((height) =>
                  Math.max(
                    20,
                    Math.min(80, height + (event.key === "ArrowUp" ? -2 : 2)),
                  ),
                );
              }}
              onPointerDown={(event) =>
                event.currentTarget.setPointerCapture(event.pointerId)
              }
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                const box =
                  event.currentTarget.parentElement?.getBoundingClientRect();
                if (box)
                  setEditorHeight(
                    Math.max(
                      20,
                      Math.min(
                        80,
                        (100 * (event.clientY - box.top)) / box.height,
                      ),
                    ),
                  );
              }}
              onPointerUp={() =>
                window.dispatchEvent(new Event("workdeck:resize-end"))
              }
              onPointerCancel={() =>
                window.dispatchEvent(new Event("workdeck:resize-end"))
              }
            />
          )}
          <div className="terminal-sessions">
            {mode === "workspace" && !active && (
              <div className="workbench-empty-session">
                <span>选择一个会话以打开对应的文件和终端</span>
                <button
                  className="secondary"
                  onClick={() => setModal("sessions")}
                >
                  选择会话
                </button>
              </div>
            )}
            {tabs.map((id) => {
              const t = data.terminals.find((t) => t.id === id);
              if (!t) return null;
              return (
                <TerminalView
                  key={id}
                  terminal={t}
                  node={data.nodes.find((n) => n.id === t.node_id)}
                  visible={active === id}
                  layoutVisible={
                    mode !== "workspace" || panelLayout !== "editor"
                  }
                  fontSize={fontSize}
                  onFontSizeChange={changeFontSize}
                  onBack={() => setActive(null)}
                  onStop={() => void stop(t)}
                  notify={notify}
                />
              );
            })}
          </div>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {relayDownload && (
        <RelayDownloadDialog
          size={relayDownload.size}
          onClose={relayDownload.done}
        />
      )}
      {modal && (
        <div
          className="modal-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <section
            ref={modalElement}
            className={
              "modal" + (modal === "create-codex" ? " modal-codex" : "")
            }
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "pending-writes"
                ? "节点待处理写入"
                : modal === "sessions"
                  ? "会话管理"
                  : modal === "nodes"
                    ? "节点管理"
                    : modal === "account"
                      ? "账户管理"
                      : modal === "settings"
                        ? "设置"
                        : modal === "file-close"
                          ? "关闭文件"
                          : modal === "workspace-root"
                            ? "更换工作区目录"
                            : modal === "archived-intent"
                              ? "核对旧目录操作"
                              : modal === "archived-save"
                                ? "核对旧目录保存"
                                : modal === "file-create"
                                  ? "新建文件或文件夹"
                                  : modal === "file-discard-draft"
                                    ? "移除本地草稿"
                                    : modal === "file-save-as"
                                      ? deletedSaveTarget?.unavailable
                                        ? "另存不可访问的草稿"
                                        : "另存已删除的草稿"
                                      : modal === "file-delete"
                                        ? "删除文件或文件夹"
                                        : modal === "file-rename"
                                          ? "重命名文件或文件夹"
                                          : modal === "create-codex"
                                            ? "新建 Codex"
                                            : modal === "node-proxy"
                                              ? "节点代理设置"
                                              : modal === "create"
                                                ? "新建终端"
                                                : modal === "join"
                                                  ? "接入节点"
                                                  : modal === "rename"
                                                    ? renameTarget?.kind ===
                                                      "node"
                                                      ? "重命名节点"
                                                      : "重命名终端"
                                                    : modal === "terminate"
                                                      ? "终止终端"
                                                      : "修改密码"
            }
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭对话框"
              disabled={
                (modal === "workspace-root" && rootModalBusy) ||
                (modal === "pending-writes" && pendingModalBusy) ||
                ((modal === "archived-intent" || modal === "archived-save") &&
                  archiveModalBusy)
              }
              onClick={closeModal}
            >
              <X size={20} />
            </button>
            {modal === "pending-writes" ? (
              <PendingWritesForm
                controller={workspace}
                onClose={closeModal}
                onBusy={setPendingModalBusy}
              />
            ) : modal === "archived-save" && archivedSave ? (
              <ArchivedSaveForm
                controller={workspace}
                identity={archivedSave.identity}
                source={archivedSave.source}
                onClose={closeModal}
                onBusy={setArchiveModalBusy}
              />
            ) : modal === "archived-intent" && archivedIntent ? (
              <ArchivedIntentForm
                controller={workspace}
                intent={archivedIntent}
                onClose={closeModal}
                onBusy={setArchiveModalBusy}
                onRemoved={() => {
                  setModal(null);
                  setArchivedIntent(null);
                  notify("已移除本地操作记录");
                }}
              />
            ) : modal === "workspace-root" && current ? (
              <WorkspaceRootForm
                controller={workspace}
                terminal={current}
                node={data.nodes.find((n) => n.id === current.node_id)}
                onCancel={closeModal}
                onBusy={setRootModalBusy}
                onDone={(state) => {
                  setModal(null);
                  notify(
                    state === "changed"
                      ? "工作区目录已更换"
                      : "目录切换正在恢复，请稍后查看",
                  );
                }}
              />
            ) : modal === "file-close" && closeDocumentTarget ? (
              <CloseDocumentForm
                controller={workspace}
                doc={closeDocumentTarget}
                onClose={() => {
                  setModal(null);
                  setCloseDocumentTarget(null);
                }}
              />
            ) : modal === "sessions" ? (
              <SessionsPanel
                nodes={data.nodes}
                terminals={data.terminals}
                active={active}
                onOpen={(id) => {
                  open(id);
                  setModal(null);
                }}
                onCreate={() => openChild("create", "sessions")}
                onCreateCodex={() => openChild("create-codex", "sessions")}
                onRename={(t) => {
                  setRenameTarget({ kind: "terminal", id: t.id, name: t.name });
                  openChild("rename", "sessions");
                }}
                onTerminate={(t) => {
                  setTerminationTarget(t);
                  openChild("terminate", "sessions");
                }}
              />
            ) : modal === "nodes" ? (
              <NodesPanel
                nodes={data.nodes}
                terminals={data.terminals}
                onJoin={() => openChild("join", "nodes")}
                onProxy={(node) => configureProxy(node, "nodes")}
                onRename={(n) => {
                  setRenameTarget({ kind: "node", id: n.id, name: n.name });
                  openChild("rename", "nodes");
                }}
                onRevoke={(n) => void revoke(n)}
              />
            ) : modal === "account" ? (
              <AccountPanel
                username={user.username}
                onPassword={() => openChild("password", "account")}
                onLogout={() => {
                  void api("/logout", { method: "POST" })
                    .then(() => {
                      setModal(null);
                      setUser(null);
                      setTabs([]);
                      setActive(null);
                    })
                    .catch((e) => notify((e as Error).message));
                }}
              />
            ) : modal === "settings" ? (
              <SettingsPanel
                fontSize={fontSize}
                onFontSize={changeFontSize}
                autoSave={autoSave}
                onAutoSave={changeAutoSave}
              />
            ) : modal === "file-discard-draft" && deletedSaveTarget ? (
              <DiscardDeletedDraftForm
                controller={workspace}
                doc={deletedSaveTarget}
                onClose={() => setModal(null)}
              />
            ) : modal === "file-save-as" && deletedSaveTarget ? (
              <SaveDeletedAsForm
                controller={workspace}
                doc={deletedSaveTarget}
                onClose={() => setModal(null)}
              />
            ) : modal === "file-delete" ? (
              <DeleteItemForm
                controller={workspace}
                path={fileDeleteTarget.path}
                directory={fileDeleteTarget.directory}
                existing={fileDeleteTarget.intent}
                onClose={() => setModal(null)}
              />
            ) : modal === "file-rename" ? (
              <RenameItemForm
                controller={workspace}
                source={fileRenameTarget}
                onCancel={() => setModal(null)}
                onRenamed={() => {
                  setModal(null);
                  notify("重命名成功");
                }}
              />
            ) : modal === "file-create" ? (
              <CreateItemForm
                controller={workspace}
                onCancel={() => setModal(null)}
                onCreated={() => {
                  setModal(null);
                  notify("创建成功");
                }}
              />
            ) : modal === "node-proxy" && proxyNode ? (
              <NodeCodexSettings
                node={proxyNode}
                onCancel={closeModal}
                onSaved={() => {
                  void refresh();
                  closeModal();
                  notify("节点默认代理已保存");
                }}
              />
            ) : modal === "create" || modal === "create-codex" ? (
              <CreateTerminal
                kind={modal === "create-codex" ? "codex" : "shell"}
                nodes={data.nodes}
                selected={
                  modalParent === "sessions"
                    ? current?.node_id || filter
                    : filter
                }
                onCreated={async (id) => {
                  setModal(null);
                  setModalParent(null);
                  await refresh();
                  open(id);
                }}
              />
            ) : modal === "join" ? (
              <JoinNode notify={notify} />
            ) : modal === "rename" && renameTarget ? (
              <RenameForm
                target={renameTarget}
                onCancel={closeModal}
                onSaved={(name) => {
                  const target = renameTarget;
                  setData((previous) =>
                    target.kind === "node"
                      ? {
                          ...previous,
                          nodes: previous.nodes.map((node) =>
                            node.id === target.id ? { ...node, name } : node,
                          ),
                        }
                      : {
                          ...previous,
                          terminals: previous.terminals.map((terminal) =>
                            terminal.id === target.id
                              ? { ...terminal, name }
                              : terminal,
                          ),
                        },
                  );
                  closeModal();
                  setRenameTarget(null);
                  notify(
                    target.kind === "node"
                      ? "节点名称已更新"
                      : "终端名称已更新",
                  );
                  void refresh();
                }}
              />
            ) : modal === "terminate" && terminationTarget ? (
              <TerminateForm
                terminal={terminationTarget}
                node={data.nodes.find(
                  (node) => node.id === terminationTarget.node_id,
                )}
                onCancel={closeModal}
                onSubmitted={(terminal) => {
                  closeTab(terminal.id);
                  setData((previous) => ({
                    ...previous,
                    terminals: previous.terminals.map((item) =>
                      item.id === terminal.id ? terminal : item,
                    ),
                  }));
                  closeModal();
                  setTerminationTarget(null);
                  notify(
                    terminal.state === "closed"
                      ? "终端已终止"
                      : "终止请求已保存，等待节点确认",
                  );
                  void refresh();
                }}
              />
            ) : (
              <Password
                onSaved={() => {
                  closeModal();
                  notify("密码已更新，其他设备需要重新登录");
                }}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <div>
        <Command size={21} />
      </div>
      <span>workdeck</span>
      <small>BETA</small>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-page">
      <div className="login-decoration">
        <span className="orb one" />
        <span className="orb two" />
        <div className="login-story">
          <div className="eyebrow">ONE WORKSPACE. EVERY MACHINE.</div>
          <h1>
            你的工作现场，
            <br />
            一直都在<span>.</span>
          </h1>
          <p>
            无论在哪个屏幕，
            <br />
            随时接回你的终端与任务。
          </p>
          <div className="story-terminal">
            <div>
              <i />
              <i />
              <i />
              <span>your-machine ~</span>
            </div>
            <p>
              <b>❯</b> 开始一项值得投入的工作
              <span className="cursor" />
            </p>
            <small>session running · you can safely disconnect</small>
          </div>
        </div>
      </div>
      <div className="login-panel">
        <Brand />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setBusy(true);
            try {
              onLogin(
                await api<User>("/login", {
                  method: "POST",
                  body: JSON.stringify({ username, password }),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">WELCOME BACK</span>
          <h2>登录工作台</h2>
          <p>连接你的机器，继续你的工作。</p>
          <label>
            用户名
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "正在登录…" : "进入工作台"}
            <ArrowRight size={17} />
          </button>
          <div className="login-note">
            <ShieldCheck size={15} />
            独立部署 · 加密连接
          </div>
          <p className="login-persistence">
            此设备保留登录，多设备可同时使用。仅主动退出或登录过期时需重新登录。
          </p>
        </form>
        <div className="login-copyright">Workdeck / 让工作不受设备限制</div>
      </div>
    </div>
  );
}
void migrateBrowserState().then((warning) => {
  createRoot(document.getElementById("root")!).render(<App />);
  if (warning) {
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:9999;max-width:420px;padding:12px 16px;background:#242936;color:#fff;border:1px solid #65708a;border-radius:8px;box-shadow:0 6px 24px #0006;font:14px/1.5 system-ui";
    notice.textContent = "浏览器迁移提示：" + warning;
    const close = document.createElement("button");
    close.textContent = "关闭";
    close.style.cssText =
      "margin-left:12px;color:inherit;background:transparent;border:0;cursor:pointer";
    close.onclick = () => notice.remove();
    notice.appendChild(close);
    document.body.appendChild(notice);
  }
});
