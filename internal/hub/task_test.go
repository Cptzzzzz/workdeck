package hub

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"workdeck/internal/protocol"
)

func TestTaskMetadataAndCodexInventoryRemainIndependent(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node, terminal := randomID(), randomID()
	if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "node", "key"); err != nil {
		t.Fatal(err)
	}
	if _, err := x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", terminal, node, "term", "/tmp", "running", "running", now(), now(), ""); err != nil {
		t.Fatal(err)
	}
	if code, _ := x.request(t, "PUT", "/api/terminals/"+terminal+"/task", map[string]any{"note": "my note", "tags": "work", "important": true}, true); code != 200 {
		t.Fatal(code)
	}
	msg := protocol.Message{Complete: true, Sessions: []protocol.Session{{ID: terminal, State: "running", Codex: &protocol.CodexObservation{TurnID: "event", CompletedAt: "2026-01-01T00:00:00Z", LaunchCommand: "cmd"}}}}
	x.h.applyInventory(node, msg)
	// An older agent without Codex support must not erase observations.
	msg.Sessions[0].Codex = nil
	x.h.applyInventory(node, msg)
	msg.Sessions[0].Codex = &protocol.CodexObservation{LaunchCommand: "new command"}
	x.h.applyInventory(node, msg)
	code, state := x.request(t, "GET", "/api/state", nil, false)
	if code != 200 {
		t.Fatal(code)
	}
	task := state["terminals"].([]any)[0].(map[string]any)["task"].(map[string]any)
	if task["note"] != "my note" || task["important"] != true || task["codex_turn"] != "event" {
		t.Fatal(task)
	}
	cfg := x.h.cfg
	cfg.PasswordFile = "/does/not/exist"
	x.s.Close()
	if err := x.h.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(restored.Handler())
	restored.cfg.PublicURL = server.URL
	defer server.Close()
	defer restored.store.db.Close()
	x.h, x.s = restored, server
	code, state = x.request(t, "GET", "/api/state", nil, false)
	if code != 200 {
		t.Fatal(code)
	}
	task = state["terminals"].([]any)[0].(map[string]any)["task"].(map[string]any)
	if task["note"] != "my note" || task["codex_turn"] != "event" {
		t.Fatal("restart lost task data", task)
	}
}

func TestStateEventsRequiresLoginAndSignalsChanges(t *testing.T) {
	x := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", x.s.URL+"/api/events", nil)
	resp, err := x.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unauthenticated event stream", resp.StatusCode)
	}
	x.signIn(t)
	req, _ = http.NewRequestWithContext(ctx, "GET", x.s.URL+"/api/events", nil)
	resp, err = x.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, "connected") {
		t.Fatal("missing stream handshake", line, err)
	}
	x.h.publishState()
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(line) == "event: state" {
			break
		}
	}
}

func TestCodexObservationsIgnoreStaleAndForeignNodeEvents(t *testing.T) {
	x := setup(t)
	node, other, terminal := randomID(), randomID(), randomID()
	for _, id := range []string{node, other} {
		if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", id, id, "key"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", terminal, node, "term", "/tmp", "running", "running", now(), now(), ""); err != nil {
		t.Fatal(err)
	}
	newer := &protocol.CodexObservation{Status: "running", EventID: "new", ObservedAt: "2026-01-01T00:00:03.000000000Z"}
	older := &protocol.CodexObservation{Status: "attention", EventID: "old", ObservedAt: "2026-01-01T00:00:02.000000000Z"}
	if err := saveCodexObservation(x.h.store.db, node, terminal, newer); err != nil {
		t.Fatal(err)
	}
	if err := saveCodexObservation(x.h.store.db, node, terminal, older); err != nil {
		t.Fatal(err)
	}
	foreign := &protocol.CodexObservation{Status: "attention", EventID: "foreign", ObservedAt: "2026-01-01T00:00:04.000000000Z"}
	if err := saveCodexObservation(x.h.store.db, other, terminal, foreign); err != nil {
		t.Fatal(err)
	}
	var status, event string
	if err := x.h.store.db.QueryRow("SELECT codex_status,codex_event FROM terminal_tasks WHERE terminal_id=?", terminal).Scan(&status, &event); err != nil {
		t.Fatal(err)
	}
	if status != "running" || event != "new" {
		t.Fatal("stale or foreign event overwrote current state", status, event)
	}
}
