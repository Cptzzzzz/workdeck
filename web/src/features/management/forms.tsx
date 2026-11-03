import { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Folder,
  Command,
  Eye,
  EyeOff,
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
import { Select } from "../../components/select";

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
  kind = "shell",
  onCreated,
}: {
  nodes: Node[];
  selected: string;
  kind?: "shell" | "codex";
  onCreated: (id: string) => void;
}) {
  const online = nodes.filter((n) => n.online);
  const initial = online.find((n) => n.id === selected) || online[0];
  const [node, setNode] = useState(initial?.id || "");
  const [name, setName] = useState(
    kind === "codex" ? "新 Codex 任务" : "新终端",
  );
  const [cwd, setCwd] = useState(initial?.home || "");
  const [proxy, setProxy] = useState("");
  const [proxyBusy, setProxyBusy] = useState(kind === "codex");
  const [proxyError, setProxyError] = useState("");
  const [confirm, setConfirm] = useState(true);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [resume, setResume] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editedProxy = useRef(false);
  useEffect(() => {
    if (kind !== "codex" || !node) {
      setProxyBusy(false);
      return;
    }
    const controller = new AbortController();
    editedProxy.current = false;
    setProxy("");
    setProxyBusy(true);
    setProxyError("");
    api<{ proxy: string }>(`/nodes/${node}/codex-settings`, {
      signal: controller.signal,
    })
      .then((config) => {
        if (!controller.signal.aborted && !editedProxy.current)
          setProxy(config.proxy);
      })
      .catch((e) => {
        if (!controller.signal.aborted && !editedProxy.current)
          setProxyError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProxyBusy(false);
      });
    return () => controller.abort();
  }, [node, kind]);
  const currentNode = nodes.find((n) => n.id === node);
  return (
    <form
      className={kind === "codex" ? "create-codex-form" : undefined}
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
                      proxy_mode: proxy.trim() ? "custom" : "none",
                      ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
                      approval: confirm ? "on-request" : "never",
                      sandbox: confirm
                        ? "workspace-write"
                        : "danger-full-access",
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
        {kind === "codex" ? (
          <Command size={24} />
        ) : (
          <TerminalSquare size={24} />
        )}
      </div>
      <h2>{kind === "codex" ? "新建 Codex 任务" : "开启新的工作"}</h2>
      <p className="modal-description">
        {kind === "codex"
          ? "直接进入 Codex，离开页面后任务继续运行。"
          : "在节点上创建独立会话，离开页面后持续运行。"}
      </p>
      <div
        className={`create-basic-fields ${kind === "codex" ? "two-columns" : ""}`}
      >
        <label>
          计算节点
          <Select
            aria-label="计算节点"
            value={node}
            options={online.map((n) => ({
              value: n.id,
              label: `${n.name} · ${n.platform}`,
            }))}
            onChange={(value) => {
              setProxy("");
              setProxyBusy(kind === "codex");
              setProxyError("");
              setNode(value);
              setCwd(nodes.find((n) => n.id === value)?.home || "");
            }}
          />
        </label>
        <label>
          {kind === "codex" ? "任务名称" : "终端名称"}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoFocus
            data-autofocus
          />
        </label>
      </div>
      <DirectoryPicker
        key={node}
        node={currentNode}
        value={cwd}
        onChange={setCwd}
      />
      {kind === "codex" && (
        <>
          <div className="codex-field-grid">
            <label>
              模型
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={128}
                placeholder="沿用节点默认模型"
              />
            </label>
            <label>
              推理强度
              <Select
                aria-label="推理强度"
                value={effort}
                options={[
                  { value: "", label: "沿用节点设置" },
                  ...["minimal", "low", "medium", "high", "xhigh"].map(
                    (value) => ({
                      value,
                      label:
                        (
                          {
                            minimal: "极低",
                            low: "低",
                            medium: "中",
                            high: "高",
                            xhigh: "极高",
                          } as Record<string, string>
                        )[value] + ` · ${value}`,
                    }),
                  ),
                ]}
                onChange={setEffort}
              />
            </label>
          </div>
          <ProxyAddress
            value={proxy}
            onChange={(value) => {
              editedProxy.current = true;
              setProxyBusy(false);
              setProxy(value);
              setProxyError("");
            }}
            busy={proxyBusy}
          />
          <p className="form-hint">
            默认使用节点保存的代理，本次修改仅影响此任务；留空不使用代理。
          </p>
          {proxyError && (
            <div className="form-error" role="alert">
              读取节点代理失败：{proxyError}。请手动确认代理地址。
            </div>
          )}
          <label className="codex-confirm-toggle">
            <span>
              <b>执行命令前确认</b>
              <small>
                {confirm
                  ? "工作区内执行，按需请求确认"
                  : "免确认执行，使用完整执行权限"}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="执行命令前确认"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
          </label>
          <details className="codex-resume-options">
            <summary>恢复已有会话</summary>
            <label>
              会话 UUID
              <input
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                maxLength={64}
                placeholder="可选：填写要继续的 Codex 会话"
              />
            </label>
          </details>
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!online.length && (
        <div className="form-error">当前没有在线节点，请先接入机器。</div>
      )}
      {kind === "codex" &&
        currentNode &&
        !currentNode.capabilities?.includes("managed-codex-v1") && (
          <div className="form-error">请先升级此节点以启动 Codex。</div>
        )}
      <button
        className="primary full"
        disabled={
          busy ||
          !node ||
          (kind === "codex" &&
            (proxyBusy ||
              !!proxyError ||
              !currentNode?.capabilities?.includes("managed-codex-v1")))
        }
      >
        {busy ? "正在创建…" : kind === "codex" ? "启动 Codex" : "创建并连接"}
        <ArrowRight size={17} />
      </button>
    </form>
  );
}

function ProxyAddress({
  value,
  onChange,
  busy = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      代理地址
      <span className="proxy-address-input">
        <input
          aria-label="代理地址"
          disabled={disabled}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={busy ? "正在读取节点代理…" : "http://127.0.0.1:7890"}
          maxLength={2048}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={visible ? "隐藏代理" : "显示代理"}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </label>
  );
}

export function NodeCodexSettings({
  node,
  onCancel,
  onSaved,
}: {
  node: Node;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [proxy, setProxy] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    api<{ proxy: string }>(`/nodes/${node.id}/codex-settings`, {
      signal: c.signal,
    })
      .then((data) => {
        if (!c.signal.aborted) setProxy(data.proxy);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [node.id]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api(`/nodes/${node.id}/codex-settings`, {
            method: "PUT",
            body: JSON.stringify({ proxy: proxy.trim() }),
          });
          onSaved();
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <Server size={24} />
      </div>
      <h2>节点代理设置</h2>
      <p className="modal-description">
        为 {node.name} 设置默认代理，新建 Codex 任务时自动填入。
      </p>
      <ProxyAddress
        value={proxy}
        onChange={setProxy}
        busy={loading}
        disabled={loading || busy}
      />
      <p className="form-hint">
        留空可清除默认代理。设置不会改变已运行的任务。
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button className="primary" disabled={busy || loading}>
          {busy ? "正在保存…" : "保存代理"}
        </button>
      </div>
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
          <Select
            aria-label="进入子目录"
            value=""
            disabled={busy || !listing?.entries.length}
            options={[
              {
                value: "",
                label: busy
                  ? "正在读取节点目录…"
                  : listing?.entries.length
                    ? "选择子目录，继续向下浏览"
                    : "当前目录没有子目录",
                disabled: true,
              },
              ...(listing?.entries || []).map((entry) => ({
                value: entry.path,
                label: entry.name + "/",
              })),
            ]}
            onChange={(value) => {
              if (value) onChange(value);
            }}
          />
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
