package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"workdeck/internal/protocol"
)

// Inventory is authoritative after reconnect; this lightweight watcher reduces
// latency while the node is connected and never reads terminal output.
func (a *Agent) watchCodexEvents(ctx context.Context, socket *protocol.Socket) {
	seen := map[string]string{}
	first := true
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		entries, err := os.ReadDir(filepath.Join(a.sessions.dir, "codex-events"))
		if err != nil {
			first = false
			continue
		}
		for _, entry := range entries {
			id := strings.TrimSuffix(entry.Name(), ".json")
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !validID(id) {
				continue
			}
			b, err := os.ReadFile(codexEventPath(a.sessions.dir, id))
			if err != nil {
				continue
			}
			var event protocol.CodexObservation
			if json.Unmarshal(b, &event) != nil || event.EventID == "" || event.EventID == seen[id] {
				continue
			}
			if first {
				seen[id] = event.EventID
				continue
			}
			if err = socket.JSON(protocol.Message{Type: "codex.update", TerminalID: id, Codex: &event}); err != nil {
				socket.Close()
				return
			}
			seen[id] = event.EventID
		}
		first = false
	}
}

var codexHookEvents = []string{"SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"}

func codexHome() (string, error) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".codex")
	}
	if !filepath.IsAbs(dir) {
		return "", errors.New("CODEX_HOME 必须是绝对路径")
	}
	return dir, nil
}

// InstallCodexHooks merges only Workdeck's own handlers into the account's
// existing hook file. Codex's normal review and trust process still applies.
func InstallCodexHooks(dataDir string) error {
	return configureCodexHooks(dataDir, true)
}

func RemoveCodexHooks(dataDir string) error {
	return configureCodexHooks(dataDir, false)
}

func configureCodexHooks(dataDir string, enabled bool) error {
	if !filepath.IsAbs(dataDir) {
		return errors.New("节点数据目录必须是绝对路径")
	}
	home, err := codexHome()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(home, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(home, ".workdeck-hooks.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	path := filepath.Join(home, "hooks.json")
	if info, e := os.Lstat(path); e == nil && !info.Mode().IsRegular() {
		return errors.New("hooks.json 不是普通文件，无法安全合并")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	var root map[string]any
	old, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !enabled && len(old) == 0 {
		return nil
	}
	if len(old) > 2<<20 {
		return errors.New("hooks.json 过大")
	}
	if len(old) > 0 {
		if err = json.Unmarshal(old, &root); err != nil || root == nil {
			return errors.New("hooks.json 格式无效")
		}
	} else {
		root = map[string]any{}
	}
	var hooks map[string]any
	if existing, ok := root["hooks"]; ok {
		var valid bool
		hooks, valid = existing.(map[string]any)
		if !valid {
			return errors.New("hooks.json 中 hooks 格式无效")
		}
	} else {
		hooks = map[string]any{}
		root["hooks"] = hooks
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	command := shellQuote(self) + " codex-hook --data-dir " + shellQuote(dataDir)
	changed := false
	for _, name := range codexHookEvents {
		groups := []any{}
		if existing, ok := hooks[name]; ok {
			var valid bool
			groups, valid = existing.([]any)
			if !valid {
				return fmt.Errorf("%s Hook 格式无效", name)
			}
		}
		if !enabled {
			keptGroups := make([]any, 0, len(groups))
			for _, group := range groups {
				g, ok := group.(map[string]any)
				if !ok {
					keptGroups = append(keptGroups, group)
					continue
				}
				hs, ok := g["hooks"].([]any)
				if !ok {
					keptGroups = append(keptGroups, group)
					continue
				}
				kept := make([]any, 0, len(hs))
				removed := false
				for _, item := range hs {
					h, ok := item.(map[string]any)
					if ok && h["command"] == command {
						changed = true
						removed = true
						continue
					}
					kept = append(kept, item)
				}
				if len(kept) > 0 || !removed {
					g["hooks"] = kept
					keptGroups = append(keptGroups, g)
				}
			}
			if len(keptGroups) == 0 {
				delete(hooks, name)
			} else {
				hooks[name] = keptGroups
			}
			continue
		}
		found := false
		for _, group := range groups {
			if g, ok := group.(map[string]any); ok {
				if hs, ok := g["hooks"].([]any); ok {
					for _, item := range hs {
						if h, ok := item.(map[string]any); ok && h["command"] == command {
							found = true
						}
					}
				}
			}
		}
		if !found {
			groups = append(groups, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 2}}})
			hooks[name] = groups
			changed = true
		}
	}
	if !changed {
		return nil
	}
	// Retain an exact private backup before the first change.
	if len(old) > 0 {
		backupDir := filepath.Join(dataDir, "codex-hook-backups")
		if err = os.MkdirAll(backupDir, 0700); err != nil {
			return err
		}
		f, e := os.OpenFile(filepath.Join(backupDir, fmt.Sprintf("hooks-%d.json", time.Now().UnixNano())), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		_, e = f.Write(old)
		if e == nil {
			e = f.Sync()
		}
		if closeErr := f.Close(); e == nil {
			e = closeErr
		}
		if e != nil {
			return e
		}
	}
	return atomicJSON(path, root)
}

// HandleCodexHook is intentionally fail-open: it never blocks a Codex turn and
// never writes prompts, output, tool arguments, or transcript paths to disk.
func HandleCodexHook(dir string, input io.Reader) error {
	if os.Getenv("WORKDECK_MANAGED_CODEX") == "1" {
		return nil
	}
	if !filepath.IsAbs(dir) {
		return nil
	}
	socket := strings.SplitN(os.Getenv("TMUX"), ",", 2)[0]
	name := filepath.Base(socket)
	if !strings.HasPrefix(name, "workdeck-") {
		return nil
	}
	id := strings.TrimPrefix(name, "workdeck-")
	if !validID(id) {
		return nil
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions", id+".json")); err != nil {
		return nil
	}
	var event struct {
		Name    string `json:"hook_event_name"`
		Session string `json:"session_id"`
		Turn    string `json:"turn_id"`
		Source  string `json:"source"`
	}
	dec := json.NewDecoder(io.LimitReader(input, 4<<20))
	if err := dec.Decode(&event); err != nil {
		return err
	}
	if event.Session == "" {
		return nil
	}
	// Compact can emit SessionStart while a turn is still active.
	if event.Name == "SessionStart" && event.Source == "compact" {
		return nil
	}
	status := ""
	switch event.Name {
	case "SessionStart":
		status = "ready"
	case "UserPromptSubmit", "PostToolUse":
		status = "running"
	case "PermissionRequest":
		status = "attention"
	case "Stop":
		status = "turn_ended"
	case "Interrupt":
		status = "interrupted"
	case "SessionEnd":
		status = "session_ended"
	default:
		return nil
	}
	if err := os.MkdirAll(filepath.Join(dir, "codex-events"), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "codex-events", id+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	var observation protocol.CodexObservation
	if b, e := os.ReadFile(codexEventPath(dir, id)); e == nil {
		_ = json.Unmarshal(b, &observation)
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	observation.EventID = hex.EncodeToString(nonce[:])
	observation.Status = status
	observation.ObservedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
	observation.ProcessKey = currentAncestorCodexKey(os.Getppid())
	detected := true
	observation.Detected = &detected
	if status == "turn_ended" && event.Turn != "" {
		hash := sha256.Sum256([]byte(event.Session + "\x00" + event.Turn))
		observation.TurnID = hex.EncodeToString(hash[:])
		observation.CompletedAt = observation.ObservedAt
	}
	observation.LaunchCommand = ""
	return atomicJSON(codexEventPath(dir, id), observation)
}
