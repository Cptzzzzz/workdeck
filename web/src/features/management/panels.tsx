import { useState } from "react";
import {
  LogOut,
  Plus,
  Server,
  Settings2,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import type { ComputeNode, TerminalRecord } from "../../types";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../../terminal-preferences";

export function SessionsPanel({
  nodes,
  terminals,
  active,
  onOpen,
  onCreate,
  onRename,
  onTerminate,
}: {
  nodes: ComputeNode[];
  terminals: TerminalRecord[];
  active: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (terminal: TerminalRecord) => void;
  onTerminate: (terminal: TerminalRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [showEnded, setShowEnded] = useState(false);
  const shown = terminals.filter(
    (t) =>
      (showEnded || t.state !== "closed") &&
      `${t.name} ${t.cwd} ${nodes.find((n) => n.id === t.node_id)?.name || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="management-panel">
      <div className="modal-symbol">
        <TerminalSquare size={24} />
      </div>
      <h2>会话管理</h2>
      <p className="modal-description">
        选择会话继续工作；已结束的会话可查看其工作区文件。
      </p>
      <div className="management-toolbar">
        <input
          aria-label="搜索会话"
          placeholder="搜索会话、节点或目录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="secondary" onClick={onCreate}>
          <Plus size={15} />
          新建
        </button>
      </div>
      <label className="management-check">
        <input
          type="checkbox"
          checked={showEnded}
          onChange={(e) => setShowEnded(e.target.checked)}
        />
        显示已终止
      </label>
      <div className="management-list">
        {shown.map((t) => {
          const node = nodes.find((n) => n.id === t.node_id);
          const state =
            t.desired_state === "closed" && t.state !== "closed"
              ? "等待终止"
              : t.state === "closed"
                ? "已终止"
                : !node?.online
                  ? "节点离线"
                  : (
                      {
                        running: "运行中",
                        creating: "创建中",
                        exited: "已退出",
                        lost: "会话丢失",
                        error: "启动失败",
                      } as Record<string, string>
                    )[t.state] || t.state;
          const canOpen =
            !!node?.online &&
            ["running", "exited"].includes(t.state) &&
            t.desired_state !== "closed";
          const fileOnly =
            t.desired_state === "closed" ||
            ["closed", "lost", "error"].includes(t.state);
          const canBrowse =
            fileOnly &&
            !!node?.online &&
            !!node.capabilities?.includes("workspace-control-v1") &&
            !!node.capabilities?.includes("workspace-files-v1");
          return (
            <div className="management-item" key={t.id}>
              <div className="management-item-text">
                <b>
                  {t.name}
                  {active === t.id ? " · 当前" : ""}
                </b>
                <small>
                  {node?.name || "未知节点"} · {state}
                </small>
                <small title={t.cwd}>{t.cwd}</small>
              </div>
              <div className="management-item-actions">
                <button
                  disabled={fileOnly ? !canBrowse : !canOpen}
                  title={
                    fileOnly && !canBrowse
                      ? "节点离线或尚未支持文件工作区"
                      : undefined
                  }
                  onClick={() => onOpen(t.id)}
                >
                  {fileOnly ? "查看文件" : "打开"}
                </button>
                <button onClick={() => onRename(t)}>重命名</button>
                {t.desired_state !== "closed" && t.state !== "closed" && (
                  <button onClick={() => onTerminate(t)}>终止</button>
                )}
              </div>
            </div>
          );
        })}
        {!shown.length && (
          <p className="management-empty">没有符合条件的会话。</p>
        )}
      </div>
    </div>
  );
}

export function NodesPanel({
  nodes,
  terminals,
  onJoin,
  onRename,
  onRevoke,
}: {
  nodes: ComputeNode[];
  terminals: TerminalRecord[];
  onJoin: () => void;
  onRename: (node: ComputeNode) => void;
  onRevoke: (node: ComputeNode) => void;
}) {
  return (
    <div className="management-panel">
      <div className="modal-symbol">
        <Server size={24} />
      </div>
      <h2>节点管理</h2>
      <p className="modal-description">查看计算节点的连接状态和运行账户。</p>
      <div className="management-toolbar">
        <span>
          {nodes.filter((n) => n.online).length} / {nodes.length} 台在线
        </span>
        <button className="secondary" onClick={onJoin}>
          <Plus size={15} />
          接入节点
        </button>
      </div>
      <div className="management-list">
        {nodes.map((n) => (
          <div className="management-item" key={n.id}>
            <div className="management-item-text">
              <b>{n.name}</b>
              <small>
                {n.online ? "在线" : "离线"} · {n.platform || "等待首次连接"}
                {n.run_user ? ` · ${n.run_user}` : ""}
              </small>
              <small>
                {
                  terminals.filter(
                    (t) => t.node_id === n.id && t.state !== "closed",
                  ).length
                }{" "}
                个会话
              </small>
            </div>
            <div className="management-item-actions">
              <button onClick={() => onRename(n)}>重命名</button>
              <button onClick={() => onRevoke(n)}>撤销接入</button>
            </div>
          </div>
        ))}
        {!nodes.length && (
          <p className="management-empty">尚未接入计算节点。</p>
        )}
      </div>
    </div>
  );
}

export function AccountPanel({
  username,
  onPassword,
  onLogout,
}: {
  username: string;
  onPassword: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="management-panel">
      <div className="modal-symbol">
        <UserRound size={24} />
      </div>
      <h2>账户管理</h2>
      <p className="modal-description">
        当前登录：{username}。退出只影响此设备。
      </p>
      <div className="management-account-actions">
        <button className="secondary" onClick={onPassword}>
          修改密码
        </button>
        <button className="secondary" onClick={onLogout}>
          <LogOut size={15} />
          退出此设备
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({
  fontSize,
  onFontSize,
  autoSave,
  onAutoSave,
}: {
  fontSize: number;
  onFontSize: (size: number) => void;
  autoSave: boolean;
  onAutoSave: (enabled: boolean) => void;
}) {
  return (
    <div className="management-panel">
      <div className="modal-symbol">
        <Settings2 size={24} />
      </div>
      <h2>设置</h2>
      <p className="modal-description">设置保存在当前浏览器中。</p>
      <label className="management-setting">
        终端字号
        <select
          value={fontSize}
          onChange={(e) => onFontSize(Number(e.target.value))}
        >
          {Array.from(
            { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
            (_, i) => i + MIN_FONT_SIZE,
          ).map((size) => (
            <option key={size} value={size}>
              {size} px{size === DEFAULT_FONT_SIZE ? "（默认）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="management-check">
        <input
          type="checkbox"
          checked={autoSave}
          onChange={(e) => onAutoSave(e.target.checked)}
        />
        停止输入后自动保存文件
      </label>
      <p className="modal-description">
        默认关闭；遇到冲突、连接中断或保存结果待确认时暂停。
      </p>
    </div>
  );
}
