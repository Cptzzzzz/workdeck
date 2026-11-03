package hub

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"workdeck/internal/protocol"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestFeishuSettingsProtectCredentialsAndRequireCSRF(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	input := map[string]any{"enabled": true, "app_id": "cli_fixture", "app_secret": "secret-fixture", "receive_type": "open_id", "receive_id": "ou_fixture", "complete": true, "attention": true}
	if code, _ := x.request(t, "PUT", "/api/integrations/feishu", input, false); code != 403 {
		t.Fatal("missing csrf", code)
	}
	if code, out := x.request(t, "PUT", "/api/integrations/feishu", input, true); code != 200 {
		t.Fatal(code, out)
	}
	code, out := x.request(t, "GET", "/api/integrations/feishu", nil, false)
	if code != 200 || out["has_secret"] != true || out["app_secret"] != nil {
		t.Fatal(code, out)
	}
	var blob []byte
	if e := x.h.store.db.QueryRow("SELECT secret FROM feishu_config").Scan(&blob); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(blob), "secret-fixture") {
		t.Fatal("plaintext secret stored")
	}
	delete(input, "app_secret")
	if code, out = x.request(t, "PUT", "/api/integrations/feishu", input, true); code != 200 {
		t.Fatal(code, out)
	}
	cfg, e := x.h.readFeishuConfig(true)
	if e != nil || cfg.AppSecret != "secret-fixture" {
		t.Fatal("secret not retained", e)
	}
}

func TestFeishuGoalDedupRetryAndRestart(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	cfg := map[string]any{"enabled": true, "app_id": "cli_fixture", "app_secret": "secret-fixture", "receive_type": "open_id", "receive_id": "ou_fixture", "complete": true, "attention": true}
	if code, out := x.request(t, "PUT", "/api/integrations/feishu", cfg, true); code != 200 {
		t.Fatal(code, out)
	}
	node, id, other := randomID(), randomID(), randomID()
	for _, n := range []string{node, other} {
		if _, e := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", n, "节点", "key"); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", id, node, "任务", "/tmp", "running", "running", now(), now(), ""); e != nil {
		t.Fatal(e)
	}
	o := &protocol.CodexObservation{Managed: true, ThreadID: "thread", TurnStartedAt: 125, Status: "goal_complete", EventID: "first", ObservedAt: time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano), Goal: &protocol.CodexGoal{Status: "complete", CreatedAt: 123, UpdatedAt: 130, TokensUsed: 10}}
	key, _ := protocol.CodexNotice(id, o)
	msg := protocol.Message{Type: "codex.notice", TerminalID: id, RequestID: key, Codex: o}
	if e := x.h.receiveCodexNotice(other, msg); e != nil {
		t.Fatal(e)
	}
	if e := x.h.receiveCodexNotice(node, msg); e != nil {
		t.Fatal(e)
	}
	o.EventID = "second"
	o.Goal.TokensUsed++
	if key2, _ := protocol.CodexNotice(id, o); key2 != key {
		t.Fatal("goal identity changed")
	}
	if e := x.h.receiveCodexNotice(node, msg); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := x.h.store.db.QueryRow("SELECT count(*) FROM feishu_outbox").Scan(&count); e != nil || count != 1 {
		t.Fatal(count, e)
	}
	_, _ = x.h.store.db.Exec("UPDATE feishu_outbox SET next_attempt=0")
	var mu sync.Mutex
	sent := 0
	var firstUUID string
	x.h.feishuHTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == feishuTokenURL {
			return response(200, `{"access_token":"ephemeral"}`), nil
		}
		if !strings.HasPrefix(r.URL.String(), feishuMessageURL) || r.Header.Get("Authorization") != "Bearer ephemeral" {
			t.Errorf("unexpected request %s", r.URL)
			return response(400, `{}`), nil
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["receive_id"] != "ou_fixture" || body["msg_type"] != "interactive" || !strings.Contains(body["content"], "任务") || !strings.Contains(body["content"], "terminal="+id) || !strings.Contains(body["content"], "北京时间") || !strings.Contains(body["content"], "打开此终端") {
			t.Errorf("bad message: %v", body)
		}
		mu.Lock()
		defer mu.Unlock()
		sent++
		if sent == 1 {
			firstUUID = body["uuid"]
			return response(503, `{}`), nil
		}
		if body["uuid"] != firstUUID {
			t.Error("retry changed idempotency key")
		}
		return response(200, `{"code":0,"data":{"message_id":"om_fixture"}}`), nil
	})}
	x.h.deliverFeishuNotice(context.Background())
	var state, problem string
	_ = x.h.store.db.QueryRow("SELECT state,error FROM feishu_outbox WHERE event_key=?", key).Scan(&state, &problem)
	if state != "pending" || problem == "" {
		t.Fatal(state, problem)
	}
	// The persistent queue is readable by a fresh Hub instance after restart.
	h, e := New(x.h.cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer h.store.db.Close()
	h.feishuHTTP = x.h.feishuHTTP
	_, _ = h.store.db.Exec("UPDATE feishu_outbox SET next_attempt=0")
	h.deliverFeishuNotice(context.Background())
	var messageID string
	_ = h.store.db.QueryRow("SELECT state,message_id FROM feishu_outbox WHERE event_key=?", key).Scan(&state, &messageID)
	if state != "sent" || messageID != "om_fixture" || sent != 2 {
		t.Fatal(state, messageID, sent)
	}
}

func TestCodexNoticeIgnoresActiveGoalAndPreviousConfiguration(t *testing.T) {
	o := &protocol.CodexObservation{Managed: true, ThreadID: "t", TurnID: "turn", EventID: "event", ObservedAt: time.Now().Format(time.RFC3339Nano), Status: "turn_ended", Goal: &protocol.CodexGoal{Status: "active", CreatedAt: 1}}
	if key, _ := protocol.CodexNotice(randomID(), o); key != "" {
		t.Fatal("active goal was treated as completed")
	}
	x := setup(t)
	x.signIn(t)
	node, id := randomID(), randomID()
	_, _ = x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "node", "key")
	_, _ = x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", id, node, "task", "/tmp", "running", "running", now(), now(), "")
	cfg := map[string]any{"enabled": true, "app_id": "cli_fixture", "app_secret": "secret-fixture", "receive_type": "open_id", "receive_id": "ou_fixture", "complete": true, "attention": true}
	if code, out := x.request(t, "PUT", "/api/integrations/feishu", cfg, true); code != 200 {
		t.Fatal(code, out)
	}
	o.Status = "goal_complete"
	o.Goal.Status = "complete"
	o.ObservedAt = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	key, _ := protocol.CodexNotice(id, o)
	if e := x.h.receiveCodexNotice(node, protocol.Message{TerminalID: id, RequestID: key, Codex: o}); e != nil {
		t.Fatal(e)
	}
	var count int
	_ = x.h.store.db.QueryRow("SELECT count(*) FROM feishu_outbox").Scan(&count)
	if count != 0 {
		t.Fatal("sent historical event")
	}
}

func TestFeishuHistoricalGoalAndBeijingTime(t *testing.T) {
	if got := feishuBeijingTime("2026-11-03T09:37:13.047Z"); got != "2026-11-03 17:37:13（北京时间）" {
		t.Fatal(got)
	}
	x := setup(t)
	x.signIn(t)
	cfg := map[string]any{"enabled": true, "app_id": "cli_fixture", "app_secret": "secret-fixture", "receive_type": "open_id", "receive_id": "ou_fixture", "complete": true, "attention": true}
	if code, out := x.request(t, "PUT", "/api/integrations/feishu", cfg, true); code != 200 {
		t.Fatal(code, out)
	}
	node, id := randomID(), randomID()
	_, _ = x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "node", "key")
	_, _ = x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", id, node, "task", "/tmp", "running", "running", now(), now(), "")
	legacy := &protocol.CodexObservation{Managed: true, ThreadID: "thread", TurnID: "turn", Status: "goal_complete", EventID: "event", ObservedAt: time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano), Goal: &protocol.CodexGoal{Status: "complete", CreatedAt: 100}}
	if safeCodexObservation(legacy).Status != "unknown" {
		t.Fatal("unverified legacy goal reported complete")
	}
	key, _ := protocol.CodexNotice(id, legacy)
	if e := x.h.receiveCodexNotice(node, protocol.Message{TerminalID: id, RequestID: key, Codex: legacy}); !errors.Is(e, errGoalMetadataPending) {
		t.Fatal("legacy event was not retained for refinement", e)
	}
	legacy.Goal.UpdatedAt = 130
	legacy.TurnStartedAt = 200
	corrected := safeCodexObservation(legacy)
	if corrected.Status != "turn_ended" {
		t.Fatal("historical goal hid ordinary turn")
	}
	key, kind := protocol.CodexNotice(id, corrected)
	if kind != "turn_complete" {
		t.Fatal(kind)
	}
	if e := x.h.receiveCodexNotice(node, protocol.Message{TerminalID: id, RequestID: key, Codex: corrected}); e != nil {
		t.Fatal(e)
	}
	var stored string
	if e := x.h.store.db.QueryRow("SELECT kind FROM feishu_outbox WHERE event_key=?", key).Scan(&stored); e != nil || stored != "turn_complete" {
		t.Fatal(stored, e)
	}
}
