package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workdeck/internal/protocol"
)

func TestCodexHooksMergeAndRemovePreservesUserConfig(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	path := filepath.Join(home, "hooks.json")
	original := `{"description":"mine","hooks":{"Stop":[{"matcher":"x","hooks":[{"type":"command","command":"user-hook"}]}],"Custom":[{"hooks":[]}]}}`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := InstallCodexHooks(data); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = InstallCodexHooks(data); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if string(first) != string(second) {
		t.Fatal("installation was not idempotent")
	}
	if err = RemoveCodexHooks(data); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var expected, actual any
	_ = json.Unmarshal([]byte(original), &expected)
	_ = json.Unmarshal(after, &actual)
	e, _ := json.Marshal(expected)
	a, _ := json.Marshal(actual)
	if string(e) != string(a) {
		t.Fatalf("user hooks changed: %s", after)
	}
}

func TestCodexProcessDetectionIsLimitedToPaneDescendants(t *testing.T) {
	p := processSnapshot{1: {parent: 0, name: "shell"}, 2: {parent: 1, name: "node"}, 3: {parent: 2, name: "codex"}, 4: {parent: 0, name: "shell"}, 5: {parent: 4, name: "other"}}
	if !p.hasCodex(1) {
		t.Fatal("did not find Codex descendant")
	}
	if p.hasCodex(4) {
		t.Fatal("attributed another terminal's Codex")
	}
}

func TestCodexProcessIdentityRejectsOldOrForeignInstance(t *testing.T) {
	p := processSnapshot{1: {parent: 0, name: "shell"}, 2: {parent: 1, name: "codex", start: "100"}, 3: {parent: 0, name: "shell"}, 4: {parent: 3, name: "codex", start: "101"}}
	key := p.codexKey(2)
	if key == "" || !p.hasKey(1, key) || p.hasKey(3, key) {
		t.Fatal("process attributed to wrong terminal")
	}
	p[2] = processInfo{parent: 1, name: "codex", start: "999"}
	if p.hasKey(1, key) {
		t.Fatal("reused PID accepted as old Codex")
	}
}

func TestCodexHookTracksStatesWithoutSensitiveContent(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("a", 48)
	if err := os.Mkdir(filepath.Join(dir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions", id+".json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX", "/tmp/tmux-1000/workdeck-"+id+",1,0")
	for _, pair := range [][2]string{{"SessionStart", "ready"}, {"UserPromptSubmit", "running"}, {"PermissionRequest", "attention"}, {"PostToolUse", "running"}, {"Stop", "turn_ended"}, {"Interrupt", "interrupted"}} {
		payload := `{"hook_event_name":"` + pair[0] + `","session_id":"session","turn_id":"turn","prompt":"secret-prompt","last_assistant_message":"secret-answer"}`
		if err := HandleCodexHook(dir, strings.NewReader(payload)); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(codexEventPath(dir, id))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "secret") {
			t.Fatal("sensitive payload stored")
		}
		var observation protocol.CodexObservation
		if err = json.Unmarshal(b, &observation); err != nil {
			t.Fatal(err)
		}
		if observation.Status != pair[1] || observation.EventID == "" || observation.ObservedAt == "" {
			t.Fatal(observation)
		}
		if pair[0] == "Stop" && (observation.TurnID == "" || observation.CompletedAt == "") {
			t.Fatal("completion missing")
		}
	}
	t.Setenv("TMUX", "/tmp/not-a-workdeck-session,1,0")
	before, _ := os.ReadFile(codexEventPath(dir, id))
	_ = HandleCodexHook(dir, strings.NewReader(`{"hook_event_name":"Stop","session_id":"x"}`))
	after, _ := os.ReadFile(codexEventPath(dir, id))
	if string(before) != string(after) {
		t.Fatal("outside terminal affected state")
	}
}
