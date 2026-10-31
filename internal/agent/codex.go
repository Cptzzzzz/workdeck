package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workdeck/internal/protocol"
)

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

func codexEventPath(dir, id string) string {
	return filepath.Join(dir, "codex-events", id+".json")
}

// CodexLaunch replaces this helper with Codex and opts this invocation into
// the official notify integration. It intentionally does not edit user config.
func CodexLaunch(dir, id string, args []string) error {
	if !filepath.IsAbs(dir) || !validID(id) {
		return errors.New("invalid session")
	}
	// Refuse to attribute an invocation to a different terminal by accident.
	tmuxSocket := strings.SplitN(os.Getenv("TMUX"), ",", 2)[0]
	if filepath.Base(tmuxSocket) != socketName(id) {
		return errors.New("请在对应的 Workdeck 终端内运行此命令")
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions", id+".json")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(dir, "codex-events"), 0700); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	codex, err := exec.LookPath("codex")
	if err != nil {
		return err
	}
	notify, _ := json.Marshal([]string{self, "codex-event", "--data-dir", dir, "--terminal-id", id})
	argv := append([]string{codex, "-c", "notify=" + string(notify)}, args...)
	return syscall.Exec(codex, argv, os.Environ())
}

// CodexEvent receives the official notify JSON as an argument. Only an opaque
// event identifier and timestamp are retained; prompts and replies are ignored.
func CodexEvent(dir, id, payload string) error {
	if !filepath.IsAbs(dir) || !validID(id) || len(payload) > 4<<20 {
		return errors.New("invalid event")
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions", id+".json")); err != nil {
		return err
	}
	var event struct {
		Type   string `json:"type"`
		Thread string `json:"thread-id"`
		Turn   string `json:"turn-id"`
	}
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return errors.New("invalid event JSON")
	}
	if event.Type != "agent-turn-complete" {
		return nil
	}
	if event.Thread == "" || event.Turn == "" {
		return errors.New("missing event identity")
	}
	hash := sha256.Sum256([]byte(event.Thread + "\x00" + event.Turn))
	if err := os.MkdirAll(filepath.Join(dir, "codex-events"), 0700); err != nil {
		return err
	}
	return atomicJSON(codexEventPath(dir, id), protocol.CodexObservation{TurnID: hex.EncodeToString(hash[:]), CompletedAt: time.Now().UTC().Format(time.RFC3339Nano)})
}

func (s *Sessions) codexObservation(id string) *protocol.CodexObservation {
	dir, err := filepath.Abs(s.dir)
	if err != nil {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	observation := &protocol.CodexObservation{LaunchCommand: fmt.Sprintf("%s tracked-codex --data-dir %s --terminal-id %s --", shellQuote(executable), shellQuote(dir), shellQuote(id))}
	if b, err := os.ReadFile(codexEventPath(dir, id)); err == nil {
		var saved protocol.CodexObservation
		if json.Unmarshal(b, &saved) == nil {
			observation.TurnID, observation.CompletedAt = saved.TurnID, saved.CompletedAt
			observation.Status, observation.EventID, observation.ObservedAt = saved.Status, saved.EventID, saved.ObservedAt
			observation.Detected = saved.Detected
			observation.ProcessKey = saved.ProcessKey
		}
	}
	return observation
}
