import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  Command,
  Folder,
  LayoutGrid,
  LogOut,
  Menu,
  MoreHorizontal,
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
import { useWorkspace } from "./features/workspace/use-workspace";
import {
  WorkspaceEditor,
  WorkspaceSidebar,
  CreateItemForm,
  RenameItemForm,
} from "./features/workspace/workspace-view";
import {
  RenameForm,
  TerminateForm,
  CreateTerminal,
  JoinNode,
  Password,
} from "./features/management/forms";
import {
  FONT_SIZE_KEY,
  parseFontSize,
  readFontSize,
  saveFontSize,
} from "./terminal-preferences";

type Modal =
  | "create"
  | "join"
  | "password"
  | "rename"
  | "terminate"
  | "file-create"
  | "file-rename"
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
function App() {
  const [fontSize, setFontSize] = useState(readFontSize);
  const changeFontSize = useCallback((size: number) => {
    setFontSize(size);
    saveFontSize(size);
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FONT_SIZE_KEY || event.key === null)
        setFontSize(parseFontSize(event.key === null ? null : event.newValue));
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
    layoutNumber("workdeck.sidebar.v1", 280, 180, 600),
  );
  const [editorHeight, setEditorHeight] = useState(() =>
    layoutNumber("workdeck.editor-height.v1", 55, 20, 80),
  );
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
    setMode(next);
  };
  const workspace = useWorkspace(
    mode === "workspace",
    data.terminals.find((t) => t.id === active),
    user?.username || "",
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
  );
  const [fileRenameTarget, setFileRenameTarget] = useState("");
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
    return () => clearInterval(t);
  }, [user, refresh]);
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
          "--workbench-sidebar-width": `${sidebarWidth}px`,
          "--workbench-editor-height": `${editorHeight}%`,
        } as React.CSSProperties
      }
    >
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={"sidebar " + (menu ? "shown" : "")}>
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
                title="修改密码"
                aria-label="修改密码"
                onClick={() => setModal("password")}
              >
                <Settings2 size={17} />
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
            onNewItem={() => setModal("file-create")}
            onRename={(path) => {
              setFileRenameTarget(path);
              setModal("file-rename");
            }}
            onCreate={() => setModal("create")}
            onJoin={() => setModal("join")}
            onPassword={() => setModal("password")}
            onLogout={() => {
              void api("/logout", { method: "POST" })
                .then(() => {
                  setUser(null);
                  setTabs([]);
                  setActive(null);
                })
                .catch((e) => notify((e as Error).message));
            }}
          />
        )}
      </aside>
      {mode === "workspace" && (
        <div
          className="workbench-sidebar-grip"
          role="separator"
          aria-label="调整文件树宽度"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setSidebarWidth(Math.max(180, Math.min(600, event.clientX)));
          }}
        />
      )}
      <main>
        <header className="topbar">
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
            <div className="mode-switch" aria-label="视图模式">
              <button
                className={mode === "terminal" ? "active" : ""}
                onClick={() => void changeMode("terminal")}
              >
                终端模式
              </button>
              <button
                className={mode === "workspace" ? "active" : ""}
                onClick={() => void changeMode("workspace")}
              >
                工作区模式
              </button>
            </div>
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
        {tabs.length > 0 && (
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
                    <TerminalSquare size={15} />
                    <span>{t?.name || "终端"}</span>
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
        <div className={"overview " + (active ? "hidden" : "")}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR WORK, ALWAYS THERE</div>
              <h1>
                {selected ? selected.name : "你的远程工作台"}
                <span className="heading-dot">.</span>
              </h1>
              <p>连接任意机器，接着上次的工作继续。</p>
            </div>
            <button
              className="primary"
              onClick={() => setModal("create")}
              disabled={!online}
            >
              <Plus size={17} />
              新建终端
            </button>
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
                  ["running", "exited"].includes(t.state) &&
                  t.desired_state !== "closed";
                return (
                  <article className="terminal-card" key={t.id}>
                    <div className="card-top">
                      <span className="terminal-icon">
                        <TerminalSquare size={21} />
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
                      <button onClick={() => attachable && open(t.id)}>
                        {t.name}
                      </button>
                    </h3>
                    <div className="card-node">
                      <Server size={13} />
                      {n?.name || "已撤销节点"}
                    </div>
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
        <div className={"sessions-host " + (!active ? "hidden" : "")}>
          {mode === "workspace" && active && (
            <WorkspaceEditor controller={workspace} />
          )}
          {mode === "workspace" && active && (
            <div
              className="workbench-height-grip"
              role="separator"
              aria-label="调整编辑器和终端高度"
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
            />
          )}
          <div className="terminal-sessions">
            {tabs.map((id) => {
              const t = data.terminals.find((t) => t.id === id);
              if (!t) return null;
              return (
                <TerminalView
                  key={id}
                  terminal={t}
                  node={data.nodes.find((n) => n.id === t.node_id)}
                  visible={active === id}
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
      {modal && (
        <div
          className="modal-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "file-create"
                ? "新建文件或文件夹"
                : modal === "file-rename"
                  ? "重命名文件或文件夹"
                  : modal === "create"
                    ? "新建终端"
                    : modal === "join"
                      ? "接入节点"
                      : modal === "rename"
                        ? renameTarget?.kind === "node"
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
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            {modal === "file-rename" ? (
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
            ) : modal === "create" ? (
              <CreateTerminal
                nodes={data.nodes}
                selected={filter}
                onCreated={async (id) => {
                  setModal(null);
                  await refresh();
                  open(id);
                }}
              />
            ) : modal === "join" ? (
              <JoinNode notify={notify} />
            ) : modal === "rename" && renameTarget ? (
              <RenameForm
                target={renameTarget}
                onCancel={() => setModal(null)}
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
                  setModal(null);
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
                onCancel={() => setModal(null)}
                onSubmitted={(terminal) => {
                  closeTab(terminal.id);
                  setData((previous) => ({
                    ...previous,
                    terminals: previous.terminals.map((item) =>
                      item.id === terminal.id ? terminal : item,
                    ),
                  }));
                  setModal(null);
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
                  setModal(null);
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
createRoot(document.getElementById("root")!).render(<App />);
