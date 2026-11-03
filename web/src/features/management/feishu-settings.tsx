import { useEffect, useState } from "react";
import { BellRing, Send } from "lucide-react";
import { Select } from "../../components/select";
import { api } from "../../services/api";

type FeishuConfig = {
  enabled: boolean;
  app_id: string;
  has_secret: boolean;
  receive_type: "open_id" | "chat_id";
  receive_id: string;
  complete: boolean;
  attention: boolean;
  pending: number;
  last_error: string;
};

export function FeishuSettings() {
  const [config, setConfig] = useState<FeishuConfig | null>(null);
  const [secret, setSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    const value = await api<FeishuConfig>("/integrations/feishu");
    setConfig(value);
    setSecret("");
    setDirty(false);
  };
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  const update = (value: Partial<FeishuConfig>) => {
    setConfig((old) => (old ? { ...old, ...value } : old));
    setDirty(true);
    setMessage("");
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!config) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/integrations/feishu", {
        method: "PUT",
        body: JSON.stringify({
          enabled: config.enabled,
          app_id: config.app_id,
          app_secret: secret,
          receive_type: config.receive_type,
          receive_id: config.receive_id,
          complete: config.complete,
          attention: config.attention,
        }),
      });
      await load();
      setMessage("飞书设置已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/integrations/feishu/test", { method: "POST", body: "{}" });
      setMessage("测试通知已发送，请查看飞书");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="feishu-settings" aria-label="飞书通知">
      <div className="feishu-heading">
        <BellRing size={17} />
        <strong>飞书通知</strong>
        <span>{config?.enabled ? "已开启" : "未开启"}</span>
      </div>
      <p className="modal-description">
        在飞书接收 Codex 任务完成和需要处理的提醒，关闭浏览器后仍然生效。
      </p>
      {config && (
        <form onSubmit={save}>
          <label className="management-check">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            开启飞书通知
          </label>
          <div className="feishu-fields">
            <label>
              App ID
              <input
                autoComplete="off"
                value={config.app_id}
                onChange={(e) => update({ app_id: e.target.value })}
                placeholder="飞书自建应用 App ID"
              />
            </label>
            <label>
              App Secret
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setDirty(true);
                  setMessage("");
                }}
                placeholder={
                  config.has_secret ? "已保存，留空保持不变" : "填写应用密钥"
                }
              />
            </label>
            <label>
              接收方式
              <Select
                aria-label="飞书接收方式"
                value={config.receive_type}
                options={[
                  { value: "open_id", label: "用户私聊（Open ID）" },
                  { value: "chat_id", label: "群聊（Chat ID）" },
                ]}
                onChange={(v) =>
                  update({
                    receive_type: v === "chat_id" ? "chat_id" : "open_id",
                  })
                }
              />
            </label>
            <label>
              接收 ID
              <input
                autoComplete="off"
                value={config.receive_id}
                onChange={(e) => update({ receive_id: e.target.value })}
                placeholder={
                  config.receive_type === "open_id"
                    ? "用户 Open ID"
                    : "群聊 Chat ID"
                }
              />
            </label>
          </div>
          <div className="feishu-options">
            <label className="management-check">
              <input
                type="checkbox"
                checked={config.complete}
                onChange={(e) => update({ complete: e.target.checked })}
              />
              完成或本轮结束
            </label>
            <label className="management-check">
              <input
                type="checkbox"
                checked={config.attention}
                onChange={(e) => update({ attention: e.target.checked })}
              />
              需要处理
            </label>
          </div>
          <p className="modal-description">
            使用已发布并开启机器人的飞书企业自建应用；应用密钥加密保存在主服务。更改设置会取消旧配置下尚未发送的通知。
          </p>
          {config.pending > 0 && (
            <p className="modal-description">
              {config.pending} 条通知等待发送
              {config.last_error ? `：${config.last_error}` : ""}
            </p>
          )}
          <div className="feishu-actions">
            <button className="primary" type="submit" disabled={busy || !dirty}>
              保存飞书设置
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || dirty || !config.has_secret}
              onClick={() => void test()}
            >
              <Send size={14} />
              发送测试通知
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className="feishu-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
