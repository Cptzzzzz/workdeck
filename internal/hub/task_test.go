package hub

import (
	"net/http/httptest"
	"testing"
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
