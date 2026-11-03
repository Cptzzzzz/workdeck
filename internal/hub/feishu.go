package hub

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workdeck/internal/protocol"
)

const feishuTokenURL = "https://accounts.feishu.cn/oauth/v3/token"
const feishuMessageURL = "https://open.feishu.cn/open-apis/im/v1/messages"

type feishuConfig struct {
	Enabled     bool   `json:"enabled"`
	AppID       string `json:"app_id"`
	AppSecret   string `json:"app_secret,omitempty"`
	HasSecret   bool   `json:"has_secret"`
	ReceiveType string `json:"receive_type"`
	ReceiveID   string `json:"receive_id"`
	Complete    bool   `json:"complete"`
	Attention   bool   `json:"attention"`
	EnabledAt   string `json:"-"`
	Revision    string `json:"-"`
	Pending     int    `json:"pending"`
	LastError   string `json:"last_error"`
}

func (h *Hub) feishuCipher(create bool) (cipher.AEAD, error) {
	path := filepath.Join(h.cfg.DataDir, "feishu.key")
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && create {
		var count int
		if e := h.store.db.QueryRow("SELECT count(*) FROM feishu_config").Scan(&count); e != nil || count != 0 {
			return nil, errors.New("飞书密钥缺失，无法覆盖已有配置")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		_, err = f.Write(key)
		if err == nil {
			err = f.Sync()
		}
		if e = f.Close(); err == nil {
			err = e
		}
		if err != nil {
			_ = os.Remove(path)
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || len(key) != 32 {
		return nil, errors.New("飞书密钥无效或权限不安全")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (h *Hub) readFeishuConfig(includeSecret bool) (feishuConfig, error) {
	cfg := feishuConfig{ReceiveType: "open_id", Complete: true, Attention: true}
	var sealed []byte
	err := h.store.db.QueryRow("SELECT enabled,app_id,secret,receive_type,receive_id,complete,attention,enabled_at,revision FROM feishu_config WHERE id=1").Scan(&cfg.Enabled, &cfg.AppID, &sealed, &cfg.ReceiveType, &cfg.ReceiveID, &cfg.Complete, &cfg.Attention, &cfg.EnabledAt, &cfg.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	cfg.HasSecret = len(sealed) > 0
	if includeSecret && cfg.HasSecret {
		box, e := h.feishuCipher(false)
		if e != nil || len(sealed) < box.NonceSize() {
			return cfg, errors.New("飞书配置密钥不可用")
		}
		plain, e := box.Open(nil, sealed[:box.NonceSize()], sealed[box.NonceSize():], []byte("workdeck-feishu-v1"))
		if e != nil {
			return cfg, errors.New("飞书配置无法解密")
		}
		cfg.AppSecret = string(plain)
	}
	_ = h.store.db.QueryRow("SELECT count(*) FROM feishu_outbox WHERE state='pending'").Scan(&cfg.Pending)
	_ = h.store.db.QueryRow("SELECT error FROM feishu_outbox WHERE state='pending' AND error<>'' ORDER BY next_attempt DESC LIMIT 1").Scan(&cfg.LastError)
	return cfg, nil
}

func (h *Hub) feishuSettings(w http.ResponseWriter, r *http.Request, _ login) {
	h.feishuMu.Lock()
	defer h.feishuMu.Unlock()
	if r.Method == "GET" {
		cfg, err := h.readFeishuConfig(false)
		if err != nil {
			failure(w, 500, "读取飞书设置失败")
			return
		}
		respond(w, 200, cfg)
		return
	}
	var in feishuConfig
	if !decode(w, r, &in) {
		return
	}
	in.AppID = strings.TrimSpace(in.AppID)
	in.ReceiveID = strings.TrimSpace(in.ReceiveID)
	in.AppSecret = strings.TrimSpace(in.AppSecret)
	if in.ReceiveType != "open_id" && in.ReceiveType != "chat_id" {
		failure(w, 400, "请选择飞书用户或群聊")
		return
	}
	for _, v := range []string{in.AppID, in.AppSecret, in.ReceiveID} {
		if len(v) > 512 || strings.ContainsAny(v, "\x00\r\n") {
			failure(w, 400, "飞书配置格式无效")
			return
		}
	}
	old, e := h.readFeishuConfig(true)
	if e != nil {
		failure(w, 500, "飞书配置密钥不可用")
		return
	}
	if in.AppSecret == "" {
		in.AppSecret = old.AppSecret
	}
	if in.Enabled && (in.AppID == "" || in.AppSecret == "" || in.ReceiveID == "") {
		failure(w, 400, "启用通知前请填写 App ID、App Secret 和接收 ID")
		return
	}
	if in.AppSecret == "" {
		failure(w, 400, "请填写 App Secret")
		return
	}
	box, e := h.feishuCipher(true)
	if e != nil {
		failure(w, 500, "飞书加密密钥不可用")
		return
	}
	nonce := make([]byte, box.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		failure(w, 500, "保存飞书设置失败")
		return
	}
	sealed := box.Seal(nonce, nonce, []byte(in.AppSecret), []byte("workdeck-feishu-v1"))
	tx, e := h.store.db.Begin()
	if e != nil {
		failure(w, 500, "保存飞书设置失败")
		return
	}
	defer tx.Rollback()
	_, e = tx.Exec(`INSERT INTO feishu_config(id,enabled,app_id,secret,receive_type,receive_id,complete,attention,enabled_at,revision) VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,app_id=excluded.app_id,secret=excluded.secret,receive_type=excluded.receive_type,receive_id=excluded.receive_id,complete=excluded.complete,attention=excluded.attention,enabled_at=excluded.enabled_at,revision=excluded.revision`, in.Enabled, in.AppID, sealed, in.ReceiveType, in.ReceiveID, in.Complete, in.Attention, time.Now().UTC().Format(time.RFC3339Nano), randomID())
	if e == nil {
		_, e = tx.Exec("UPDATE feishu_outbox SET state='cancelled',error='' WHERE state='pending'")
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		failure(w, 500, "保存飞书设置失败")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (h *Hub) receiveCodexNotice(node string, msg protocol.Message) error {
	if validateID(msg.TerminalID) != nil || msg.Codex == nil || len(msg.Codex.EventID) > 128 || len(msg.Codex.ThreadID) > 128 {
		return errors.New("invalid event")
	}
	key, kind := protocol.CodexNotice(msg.TerminalID, msg.Codex)
	if key == "" || key != msg.RequestID {
		return errors.New("invalid event identity")
	}
	observed, e := time.Parse(time.RFC3339Nano, msg.Codex.ObservedAt)
	if e != nil {
		return errors.New("invalid event time")
	}
	tx, e := h.store.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var enabled, complete, attention bool
	var since, revision string
	e = tx.QueryRow("SELECT enabled,complete,attention,enabled_at,revision FROM feishu_config WHERE id=1").Scan(&enabled, &complete, &attention, &since, &revision)
	if errors.Is(e, sql.ErrNoRows) {
		return tx.Commit()
	}
	if e != nil {
		return e
	}
	enabledAt, e := time.Parse(time.RFC3339Nano, since)
	if e != nil {
		return e
	}
	isComplete := kind == "goal_complete" || kind == "turn_complete" || kind == "turn_possible"
	if enabled && !observed.Before(enabledAt) && (isComplete && complete || !isComplete && attention) {
		_, e = tx.Exec(`INSERT OR IGNORE INTO feishu_outbox(event_key,terminal_id,node_id,kind,observed_at,revision,next_attempt) SELECT ?,t.id,t.node_id,?,?,?,? FROM terminals t JOIN nodes n ON n.id=t.node_id WHERE t.id=? AND t.node_id=? AND n.revoked=0`, key, kind, msg.Codex.ObservedAt, revision, time.Now().Unix()+3, msg.TerminalID, node)
		if e != nil {
			return e
		}
	}
	return tx.Commit()
}

type feishuTokenCache struct {
	revision, token string
	expires         time.Time
}
type feishuClient struct {
	http  *http.Client
	cache *feishuTokenCache
}

func newFeishuClient() feishuClient {
	return feishuClient{http: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (h *Hub) feishuClient() feishuClient {
	if h.feishuHTTP != nil {
		return feishuClient{http: h.feishuHTTP, cache: &h.feishuToken}
	}
	c := newFeishuClient()
	c.cache = &h.feishuToken
	return c
}
func (c feishuClient) post(ctx context.Context, url string, body any, token string, out any) error {
	data, e := json.Marshal(body)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, e := c.http.Do(req)
	if e != nil {
		return errors.New("连接飞书失败")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var details struct {
			Code int `json:"code"`
		}
		if json.NewDecoder(io.LimitReader(res.Body, 128<<10)).Decode(&details) == nil && details.Code != 0 {
			return fmt.Errorf("飞书 HTTP %d（错误码 %d）", res.StatusCode, details.Code)
		}
		return fmt.Errorf("飞书 HTTP %d", res.StatusCode)
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 128<<10)).Decode(out); e != nil {
		return errors.New("飞书响应格式无效")
	}
	return nil
}
func (c feishuClient) send(ctx context.Context, cfg feishuConfig, uuid, title, body, link string) (string, error) {
	token := ""
	if c.cache != nil && c.cache.revision == cfg.Revision && time.Until(c.cache.expires) > time.Minute {
		token = c.cache.token
	}
	if token == "" {
		var auth struct {
			AccessToken string `json:"access_token"`
			Expires     int64  `json:"expires_in"`
		}
		if e := c.post(ctx, feishuTokenURL, map[string]string{"grant_type": "client_credentials", "client_id": cfg.AppID, "client_secret": cfg.AppSecret}, "", &auth); e != nil {
			return "", e
		}
		if auth.AccessToken == "" {
			return "", errors.New("飞书应用认证失败，请检查凭据")
		}
		token = auth.AccessToken
		if c.cache != nil && auth.Expires > 60 && auth.Expires < 86400 {
			*c.cache = feishuTokenCache{revision: cfg.Revision, token: token, expires: time.Now().Add(time.Duration(auth.Expires) * time.Second)}
		}
	}
	card := map[string]any{"config": map[string]bool{"wide_screen_mode": true}, "header": map[string]any{"title": map[string]string{"tag": "plain_text", "content": title}, "template": "green"}, "elements": []any{map[string]any{"tag": "div", "text": map[string]string{"tag": "plain_text", "content": body}}, map[string]any{"tag": "action", "actions": []any{map[string]any{"tag": "button", "text": map[string]string{"tag": "plain_text", "content": "打开 Workdeck"}, "type": "primary", "url": link}}}}}
	content, e := json.Marshal(card)
	if e != nil {
		return "", e
	}
	var reply struct {
		Code int `json:"code"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	e = c.post(ctx, feishuMessageURL+"?receive_id_type="+cfg.ReceiveType, map[string]string{"receive_id": cfg.ReceiveID, "msg_type": "interactive", "content": string(content), "uuid": uuid}, token, &reply)
	if e != nil {
		return "", e
	}
	if reply.Code != 0 {
		if c.cache != nil {
			*c.cache = feishuTokenCache{}
		}
		return "", fmt.Errorf("飞书发送失败，错误码 %d", reply.Code)
	}
	if reply.Data.MessageID == "" {
		return "", errors.New("飞书未返回消息标识")
	}
	return reply.Data.MessageID, nil
}

func (h *Hub) feishuTest(w http.ResponseWriter, r *http.Request, _ login) {
	h.feishuMu.Lock()
	defer h.feishuMu.Unlock()
	cfg, e := h.readFeishuConfig(true)
	if e != nil || cfg.AppID == "" || cfg.AppSecret == "" || cfg.ReceiveID == "" {
		failure(w, 400, "请先保存完整的飞书配置")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 16*time.Second)
	defer cancel()
	_, e = h.feishuClient().send(ctx, cfg, randomID(), "Workdeck 通知测试", "飞书通知已连接。任务完成或需要处理时，你会在这里收到提醒。", h.cfg.PublicURL)
	if e != nil {
		failure(w, 502, e.Error())
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func noticeText(kind string) (string, string) {
	switch kind {
	case "goal_complete":
		return "Codex Goal 已完成", "目标已完成"
	case "turn_complete":
		return "Codex 本轮已结束", "本轮已结束"
	case "turn_possible":
		return "Codex 可能已结束", "请打开终端确认任务状态"
	case "goal_paused":
		return "Codex Goal 已暂停", "需要你查看"
	case "goal_blocked":
		return "Codex Goal 受阻", "需要你处理"
	case "goal_budget_limited":
		return "Codex Goal 预算已耗尽", "需要你处理"
	case "goal_usage_limited":
		return "Codex Goal 达到用量限制", "需要你处理"
	case "interrupted":
		return "Codex 已中断", "需要你查看"
	default:
		return "Codex 需要处理", "可能需要输入或确认"
	}
}

func (h *Hub) runFeishuOutbox(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.deliverFeishuNotice(ctx)
		}
	}
}
func (h *Hub) deliverFeishuNotice(ctx context.Context) {
	h.feishuMu.Lock()
	defer h.feishuMu.Unlock()
	cfg, e := h.readFeishuConfig(true)
	if e != nil || !cfg.Enabled {
		return
	}
	var key, terminal, kind, observed, name, node string
	var attempts int
	e = h.store.db.QueryRow(`SELECT o.event_key,o.terminal_id,o.kind,o.observed_at,t.name,n.name,o.attempts FROM feishu_outbox o JOIN terminals t ON t.id=o.terminal_id JOIN nodes n ON n.id=o.node_id WHERE o.state='pending' AND o.revision=? AND o.next_attempt<=? ORDER BY o.next_attempt,o.observed_at LIMIT 1`, cfg.Revision, time.Now().Unix()).Scan(&key, &terminal, &kind, &observed, &name, &node, &attempts)
	if e != nil {
		return
	}
	if kind == "turn_complete" || kind == "turn_possible" {
		var status, timestamp string
		if h.store.db.QueryRow("SELECT codex_status,codex_observed_at FROM terminal_tasks WHERE terminal_id=?", terminal).Scan(&status, &timestamp) == nil && status != "turn_ended" {
			current, ce := time.Parse(time.RFC3339Nano, timestamp)
			event, ee := time.Parse(time.RFC3339Nano, observed)
			if ce == nil && ee == nil && !current.Before(event) {
				_, _ = h.store.db.Exec("UPDATE feishu_outbox SET state='cancelled',error='' WHERE event_key=? AND state='pending'", key)
				return
			}
		}
	}
	title, description := noticeText(kind)
	body := fmt.Sprintf("任务：%s\n节点：%s\n状态：%s\n时间：%s", name, node, description, observed)
	messageID, e := h.feishuClient().send(ctx, cfg, key[:32], title, body, h.cfg.PublicURL+"/?terminal="+terminal)
	if e == nil {
		_, _ = h.store.db.Exec("UPDATE feishu_outbox SET state='sent',sent_at=?,message_id=?,error='' WHERE event_key=? AND state='pending'", now(), messageID, key)
		return
	}
	attempts++
	delay := time.Duration(1<<min(attempts, 10)) * 5 * time.Second
	if delay > time.Hour {
		delay = time.Hour
	}
	_, _ = h.store.db.Exec("UPDATE feishu_outbox SET attempts=?,next_attempt=?,error=? WHERE event_key=? AND state='pending'", attempts, time.Now().Add(delay).Unix(), e.Error(), key)
}
