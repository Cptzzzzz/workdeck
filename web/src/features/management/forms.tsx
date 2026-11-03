import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Folder,
  KeyRound,
  Server,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { api } from "../../services/api";
import type {
  ComputeNode as Node,
  TerminalRecord as Term,
  RenameTarget,
} from "../../types";
export function RenameForm({
  target,
  onCancel,
  onSaved,
}: {
  target: RenameTarget;
  onCancel: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(target.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label = target.kind === "node" ? "节点" : "终端";
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const value = name.trim();
        if (!value) {
          setError("请输入名称");
          return;
        }
        if (new TextEncoder().encode(value).length > 100) {
          setError("名称太长，请缩短后重试");
          return;
        }
        setBusy(true);
        setError("");
        try {
          await api(
            "/" +
              (target.kind === "node" ? "nodes" : "terminals") +
              "/" +
              target.id,
            { method: "PATCH", body: JSON.stringify({ name: value }) },
          );
          onSaved(value);
        } catch (error) {
          setError((error as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        {target.kind === "node" ? (
          <Server size={24} />
        ) : (
          <TerminalSquare size={24} />
        )}
      </div>
      <h2>重命名{label}</h2>
      <p className="modal-description">
        为{label}设置一个便于识别的名称，方便下次查找。
      </p>
      <label>
        {label}名称
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          onFocus={(event) => event.currentTarget.select()}
          disabled={busy}
          maxLength={100}
          autoFocus
          required
        />
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="primary"
          disabled={busy || name.trim() === target.name}
        >
          {busy ? "正在保存…" : "保存名称"}
        </button>
      </div>
    </form>
  );
}
export function TerminateForm({
  terminal,
  node,
  onCancel,
  onSubmitted,
}: {
  terminal: Term;
  node?: Node;
  onCancel: () => void;
  onSubmitted: (terminal: Term) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          onSubmitted(
            await api<Term>("/terminals/" + terminal.id, { method: "DELETE" }),
          );
        } catch (error) {
          setError((error as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol danger-symbol">
        <Trash2 size={24} />
      </div>
      <h2>终止终端</h2>
      <p className="modal-description">
        终端「{terminal.name}」及其后台任务将被结束。
      </p>
      <div className="termination-summary">
        <TerminalSquare size={18} />
        <div>
          <b>{terminal.name}</b>
          <small>{node?.name || "计算节点"}</small>
        </div>
      </div>
      {!node?.online && (
        <div className="form-hint offline-termination">
          节点当前离线，终止请求会保存，并在节点重新上线后执行。
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          autoFocus
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button className="primary danger-button" disabled={busy}>
          {busy ? "正在提交…" : "终止终端"}
        </button>
      </div>
    </form>
  );
}
export function CreateTerminal({
  nodes,
  selected,
  onCreated,
}: {
  nodes: Node[];
  selected: string;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState("shell");
  const [proxyMode, setProxyMode] = useState("inherit");
  const [proxy, setProxy] = useState("");
  const [approval, setApproval] = useState("on-request");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [resume, setResume] = useState("");
  const online = nodes.filter((n) => n.online);
  const [node, setNode] = useState(
      online.find((n) => n.id === selected)?.id || online[0]?.id || "",
    ),
    [name, setName] = useState("新终端"),
    [cwd, setCwd] = useState(
      nodes.find(
        (n) =>
          n.id === (online.find((n) => n.id === selected)?.id || online[0]?.id),
      )?.home || "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const t = await api<Term>("/terminals", {
            method: "POST",
            body: JSON.stringify({
              node_id: node,
              name,
              cwd,
              ...(kind === "codex"
                ? {
                    launch: {
                      proxy_mode: proxyMode,
                      ...(proxyMode === "custom" ? { proxy } : {}),
                      approval,
                      sandbox,
                      model: model.trim(),
                      effort,
                      resume: resume.trim(),
                    },
                  }
                : {}),
            }),
          });
          if (t.state === "error") {
            setError(t.error || "终端启动失败");
            setBusy(false);
            return;
          }
          onCreated(t.id);
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <TerminalSquare size={24} />
      </div>
      <h2>开启新的工作</h2>
      <p className="modal-description">
        在节点上创建独立会话，离开页面后持续运行。
      </p>
      <label>
        计算节点
        <select
          value={node}
          onChange={(e) => {
            setNode(e.target.value);
            setCwd(nodes.find((n) => n.id === e.target.value)?.home || "");
          }}
        >
          {online.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} · {n.platform}
            </option>
          ))}
        </select>
      </label>
      <label>
        终端名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          autoFocus
        />
      </label>
      <DirectoryPicker
        key={node}
        node={nodes.find((n) => n.id === node)}
        value={cwd}
        onChange={setCwd}
      />
      <label>
        启动方式
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="shell">普通终端</option>
          <option
            value="codex"
            disabled={
              !nodes
                .find((n) => n.id === node)
                ?.capabilities?.includes("managed-codex-v1")
            }
          >
            Codex 受管会话
          </option>
        </select>
      </label>
      {kind === "codex" && (
        <div className="codex-launch-options">
          <p className="modal-description">
            Codex 随终端持续运行，自动识别轮次及 Goal
            状态。节点需要安装支持远程本地后端的 Codex 并完成登录。
          </p>
          <label>
            执行预设
            <select
              value={
                approval === "on-request" &&
                sandbox === "workspace-write" &&
                effort === ""
                  ? "on-request/workspace-write/"
                  : approval === "never" &&
                      sandbox === "danger-full-access" &&
                      effort === "xhigh"
                    ? "never/danger-full-access/xhigh"
                    : "custom"
              }
              onChange={(e) => {
                const [a, s, r] = e.target.value.split("/");
                setApproval(a);
                setSandbox(s);
                setEffort(r);
              }}
            >
              <option value="on-request/workspace-write/">
                标准 · 工作区写入，按需确认
              </option>
              <option value="never/danger-full-access/xhigh">
                Coder · 无需确认，完整权限，xhigh
              </option>
              <option value="custom" disabled>
                自定义配置
              </option>
            </select>
          </label>
          <label>
            代理
            <select
              aria-label="代理"
              value={proxyMode}
              onChange={(e) => setProxyMode(e.target.value)}
            >
              <option value="inherit">继承节点服务的代理环境</option>
              <option value="none">不使用代理</option>
              <option value="custom">指定代理地址</option>
            </select>
          </label>
          {proxyMode === "custom" && (
            <label>
              代理地址
              <input
                type="password"
                autoComplete="off"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="http://127.0.0.1:7890"
                required
                maxLength={2048}
              />
            </label>
          )}
          <details>
            <summary>高级启动选项</summary>
            <label>
              命令确认
              <select
                value={approval}
                onChange={(e) => setApproval(e.target.value)}
              >
                <option value="on-request">按需确认</option>
                <option value="never">无需确认</option>
              </select>
            </label>
            <label>
              文件与命令权限
              <select
                value={sandbox}
                onChange={(e) => setSandbox(e.target.value)}
              >
                <option value="read-only">只读</option>
                <option value="workspace-write">工作区写入</option>
                <option value="danger-full-access">完整权限</option>
              </select>
            </label>
            <label>
              模型
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={128}
                placeholder="沿用节点 Codex 配置"
              />
            </label>
            <label>
              推理强度
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                {["", "minimal", "low", "medium", "high", "xhigh"].map((v) => (
                  <option key={v} value={v}>
                    {v || "沿用节点 Codex 配置"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              恢复已有 Codex 会话
              <input
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                maxLength={64}
                placeholder="可选：Codex 会话 UUID"
              />
            </label>
          </details>
          <p className="modal-description">
            代理仅保存在计算节点的私有配置中。继承代理不会读取 shell 的 coder
            函数；Coder 预设只设置执行权限和推理强度。
          </p>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {!online.length && (
        <div className="form-error">当前没有在线节点，请先接入机器。</div>
      )}
      <button
        className="primary full"
        disabled={
          busy ||
          !node ||
          (kind === "codex" &&
            !nodes
              .find((n) => n.id === node)
              ?.capabilities?.includes("managed-codex-v1"))
        }
      >
        {busy ? "正在创建…" : "创建并连接"}
        <ArrowRight size={17} />
      </button>
    </form>
  );
}
type DirectoryListing = {
  path: string;
  parent: string;
  entries: { name: string; path: string }[];
  truncated: boolean;
};
export function DirectoryPicker({
  node,
  value,
  onChange,
  purpose = "terminal",
  autoFocus = false,
}: {
  node?: Node;
  value: string;
  onChange: (value: string) => void;
  purpose?: "terminal" | "workspace";
  autoFocus?: boolean;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hidden, setHidden] = useState(false);
  const supported = node?.capabilities?.includes("directories");
  useEffect(() => {
    if (!node?.online || !supported) return;
    const controller = new AbortController();
    let cancelled = false;
    setBusy(true);
    setError("");
    setListing(null);
    const timer = setTimeout(async () => {
      try {
        const result = await api<DirectoryListing>(
          "/nodes/" +
            node.id +
            "/directories?" +
            new URLSearchParams({ path: value, hidden: hidden ? "1" : "0" }),
          { signal: controller.signal },
        );
        if (cancelled) return;
        setListing(result);
        if (result.path !== value) onChange(result.path);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [node?.id, node?.online, supported, value, hidden, onChange]);
  return (
    <div className="directory-picker">
      <label>
        {purpose === "workspace" ? "工作区目录" : "工作目录"}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="使用节点的用户主目录"
          autoFocus={autoFocus}
        />
      </label>
      <div className="directory-actions">
        <button
          type="button"
          className="secondary"
          disabled={!node?.home || busy}
          onClick={() => onChange(node?.home || "")}
        >
          <Folder size={13} />
          主目录
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!listing || listing.parent === listing.path || busy}
          onClick={() => listing && onChange(listing.parent)}
        >
          <ArrowLeft size={13} />
          上一级
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          显示隐藏目录
        </label>
      </div>
      {supported ? (
        <label className="directory-select">
          子目录
          <select
            aria-label="进入子目录"
            value=""
            disabled={busy || !listing?.entries.length}
            onChange={(e) => {
              if (e.target.value) onChange(e.target.value);
            }}
          >
            <option value="">
              {busy
                ? "正在读取节点目录…"
                : listing?.entries.length
                  ? "选择子目录，继续向下浏览"
                  : "当前目录没有子目录"}
            </option>
            {listing?.entries.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.name}/
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="form-hint">
          {node?.online
            ? "升级此节点 Agent 后可选择子目录；当前可手动输入路径。"
            : "选择在线节点后可浏览目录。"}
        </p>
      )}
      {listing && (
        <small className="directory-hint">
          {purpose === "workspace"
            ? "目录浏览使用节点服务账户，最终访问权限以终端账户为准。"
            : "将在当前所选目录创建终端。"}
          {listing.truncated
            ? "目录过多，仅显示部分结果；可直接输入完整路径。"
            : "也可在上方直接输入完整路径。"}
        </small>
      )}
      {error && (
        <div className="form-error">{error}，可以检查或手动输入路径。</div>
      )}
    </div>
  );
}
export function JoinNode({ notify }: { notify: (s: string) => void }) {
  const [enrollment, setEnrollment] = useState<{
      token: string;
      expires_at: string;
      hub: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      setEnrollment(await api("/enrollments", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const command = enrollment
    ? `curl -fsS ${enrollment.hub}/install-agent.sh -o /tmp/workdeck-install.sh\nsh /tmp/workdeck-install.sh --hub ${enrollment.hub} --token ${enrollment.token}`
    : "";
  return (
    <>
      <div className="modal-symbol">
        <Server size={24} />
      </div>
      <h2>接入一台机器</h2>
      <p className="modal-description">
        在目标 Linux 机器上安装
        Agent。主服务所在机器也可接入，使用相同的终端管理方式。只需出站
        HTTPS，不需要公网 IP。
      </p>
      <div className="join-steps">
        <span>01</span>
        <div>
          <b>生成一次性加入令牌</b>
          <p>10 分钟内有效，使用后自动失效。</p>
        </div>
      </div>
      {!enrollment ? (
        <button
          className="primary full"
          disabled={busy}
          onClick={() => void generate()}
        >
          <KeyRound size={16} />
          {busy ? "正在生成…" : "生成接入命令"}
        </button>
      ) : (
        <>
          <div className="join-steps">
            <span>02</span>
            <div>
              <b>在目标机器上运行</b>
              <p>
                以希望终端使用的账户执行，需要 tmux 与 systemd；root
                将创建系统服务。
              </p>
            </div>
          </div>
          <pre className="install-command">{command}</pre>
          <button
            className="secondary full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                notify("接入命令已复制");
              } catch {
                notify("请手动复制接入命令");
              }
            }}
          >
            <Copy size={15} />
            复制接入命令
          </button>
          <p className="form-hint">
            令牌到期时间：{new Date(enrollment.expires_at).toLocaleTimeString()}
            。新节点上线后会自动出现在列表。
          </p>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void generate()}
          >
            重新生成令牌
          </button>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
export function Password({ onSaved }: { onSaved: () => void }) {
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [confirmPassword, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirmPassword) {
          setError("两次输入的密码不一致");
          return;
        }
        if (
          Array.from(password).length < 6 ||
          !/[A-Za-z]/.test(password) ||
          !/[0-9]/.test(password)
        ) {
          setError("密码至少 6 位，且同时包含英文字母和数字，大小写不限");
          return;
        }
        setBusy(true);
        setError("");
        try {
          await api("/account/password", {
            method: "POST",
            body: JSON.stringify({ current, password }),
          });
          onSaved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <KeyRound size={24} />
      </div>
      <h2>修改登录密码</h2>
      <p className="modal-description">保存后，其他设备的登录将失效。</p>
      <label>
        当前密码
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label>
        新密码
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          pattern="(?=.*[A-Za-z])(?=.*[0-9]).*"
          required
        />
        <small>至少 6 位，同时包含英文字母和数字，大小写不限。</small>
      </label>
      <label>
        确认新密码
        <input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary full" disabled={busy}>
        {busy ? "正在保存…" : "保存密码"}
      </button>
    </form>
  );
}
