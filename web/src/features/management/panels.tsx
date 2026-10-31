import { useState, useSyncExternalStore } from "react";
import {
  LogOut,
  Plus,
  Server,
  Settings2,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import type { ComputeNode, TerminalRecord } from "../../types";
import { api } from "../../services/api";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../../terminal-preferences";
import {
  readRoutePreference,
  saveRoutePreference,
  subscribeRoutePreference,
} from "../../transport-preferences";

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
      `${t.name} ${t.cwd} ${t.task?.tags || ""} ${t.task?.note || ""} ${nodes.find((n) => n.id === t.node_id)?.name || ""}`
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
                {t.task?.important && <small>★ 重要任务</small>}
                {t.task?.manual_status && (
                  <small>
                    手动状态：
                    {
                      (
                        {
                          doing: "进行中",
                          waiting: "等待处理",
                          done: "已完成",
                        } as Record<string, string>
                      )[t.task.manual_status]
                    }
                  </small>
                )}
                {t.task?.tags && <small>标签：{t.task.tags}</small>}
                {t.task?.note && <small>备注：{t.task.note}</small>}
                {t.task?.codex_completed_at && (
                  <small>
                    Codex 最近一轮结束：
                    {new Date(t.task.codex_completed_at).toLocaleString()}{" "}
                    {!node?.online && "（节点离线，信息可能过期）"}
                  </small>
                )}
                {!t.task?.codex_completed_at && (
                  <small>Codex：尚未收到轮次结束事件</small>
                )}
                <TaskEditor terminal={t} />
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

function TaskEditor({ terminal }: { terminal: TerminalRecord }) {
  const [note, setNote] = useState(terminal.task?.note || "");
  const [tags, setTags] = useState(terminal.task?.tags || "");
  const [important, setImportant] = useState(terminal.task?.important || false);
  const [manualStatus, setManualStatus] = useState(
    terminal.task?.manual_status || "",
  );
  const [message, setMessage] = useState("");
  const save = async () => {
    try {
      await api(`/terminals/${terminal.id}/task`, {
        method: "PUT",
        body: JSON.stringify({
          note,
          tags,
          important,
          manual_status: manualStatus,
        }),
      });
      setMessage("已保存，列表稍后更新");
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  return (
    <details
      className="task-editor"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setNote(terminal.task?.note || "");
          setTags(terminal.task?.tags || "");
          setImportant(terminal.task?.important || false);
          setManualStatus(terminal.task?.manual_status || "");
        }
      }}
    >
      <summary>任务详情与 Codex 跟踪</summary>
      <label>
        标签
        <input
          value={tags}
          maxLength={300}
          placeholder="例如：后端、待检查"
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <label>
        备注
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label>
        手动状态
        <select
          value={manualStatus}
          onChange={(e) => setManualStatus(e.target.value)}
        >
          <option value="">未设置</option>
          <option value="doing">进行中</option>
          <option value="waiting">等待处理</option>
          <option value="done">已完成</option>
        </select>
      </label>
      <label className="management-check">
        <input
          type="checkbox"
          checked={important}
          onChange={(e) => setImportant(e.target.checked)}
        />
        标记为重要
      </label>
      <button onClick={() => void save()}>保存任务信息</button>
      <p>
        使用下方命令在此终端启动 Codex，才能收到之后的轮次结束事件；已经运行的
        Codex 不受影响。本轮结束不代表整个任务已成功，后续仍可能需要你处理。
      </p>
      {terminal.task?.codex_command ? (
        <>
          <code className="task-command">{terminal.task.codex_command}</code>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(terminal.task!.codex_command)
                .then(
                  () => setMessage("命令已复制"),
                  () => setMessage("复制失败，请手动选择命令"),
                )
            }
          >
            复制启动命令
          </button>
          <p>
            该命令只为此次启动设置 Codex notify，会覆盖此进程已有的 notify
            配置；不同服务账户的旧终端可能无法访问节点数据目录。
          </p>
        </>
      ) : (
        <p>等待支持任务跟踪的节点上线。</p>
      )}
      {message && <small role="status">{message}</small>}
    </details>
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
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem("workdeck-task-notifications") === "on",
  );
  const routePreference = useSyncExternalStore(
    subscribeRoutePreference,
    readRoutePreference,
  );
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
      <label className="management-setting">
        链路策略
        <select
          value={routePreference}
          onChange={(event) =>
            saveRoutePreference(
              event.target.value === "balanced" ? "balanced" : "prefer-direct",
            )
          }
        >
          <option value="prefer-direct">优先直连</option>
          <option value="balanced">平衡延迟</option>
        </select>
      </label>
      <p className="modal-description">
        优先直连允许适度增加延迟以节省主服务器带宽；不稳定或延迟过高时仍会中转。策略在下一轮检测生效。
      </p>
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
      <label className="management-check">
        <input
          type="checkbox"
          checked={notifications}
          onChange={async (e) => {
            const enabled =
              e.target.checked &&
              "Notification" in window &&
              (await Notification.requestPermission()) === "granted";
            localStorage.setItem(
              "workdeck-task-notifications",
              enabled ? "on" : "off",
            );
            setNotifications(enabled);
          }}
        />
        Codex 新一轮结束时显示浏览器通知
      </label>
      <p className="modal-description">
        仅在本设备页面打开并保持登录时生效；首次打开不会补发旧通知。浏览器需要允许通知。
      </p>
    </div>
  );
}
