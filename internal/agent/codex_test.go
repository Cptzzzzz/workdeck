package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexEventStoresOnlyTurnMetadata(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("a", 48)
	if err := os.Mkdir(filepath.Join(dir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions", id+".json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CodexEvent(dir, id, `{"type":"agent-turn-complete","thread-id":"thread","turn-id":"turn","input-messages":["private prompt"],"last-assistant-message":"private output"}`); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(codexEventPath(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "private") || strings.Contains(string(b), "thread") {
		t.Fatalf("sensitive input retained: %s", b)
	}
	s := &Sessions{dir: dir}
	event := s.codexObservation(id)
	if event == nil || event.TurnID == "" || event.CompletedAt == "" || event.LaunchCommand == "" {
		t.Fatal("missing observation", event)
	}
	if err := CodexEvent(dir, id, `{"type":"other"}`); err != nil {
		t.Fatal(err)
	}
	if s.codexObservation(id).TurnID != event.TurnID {
		t.Fatal("unrelated event changed completion")
	}
	if err := CodexEvent(dir, "../bad", `{}`); err == nil {
		t.Fatal("accepted invalid ID")
	}
}
