package agent

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workdeck/internal/protocol"
)

type codexNotice struct {
	TerminalID  string                    `json:"terminal_id"`
	Observation protocol.CodexObservation `json:"observation"`
}

func noticeDir(dir string) string { return filepath.Join(dir, "codex-notification-outbox") }

func sameNoticeState(a, b protocol.CodexObservation) bool {
	return a.Status == b.Status && a.TurnID == b.TurnID &&
		(a.Goal == nil && b.Goal == nil || a.Goal != nil && b.Goal != nil && a.Goal.CreatedAt == b.Goal.CreatedAt)
}

func spoolCodexNotice(dir, id string, o, previous protocol.CodexObservation) bool {
	// The first observation is a baseline, not a new completion.
	if previous.Status == "" || sameNoticeState(previous, o) {
		return true
	}
	key, _ := protocol.CodexNotice(id, &o)
	if key == "" {
		return true
	}
	o.LaunchCommand, o.ProcessKey = "", ""
	if err := os.MkdirAll(noticeDir(dir), 0700); err != nil {
		log.Printf("codex notice spool: %v", err)
		return false
	}
	if err := atomicJSON(filepath.Join(noticeDir(dir), key+".json"), codexNotice{TerminalID: id, Observation: o}); err != nil {
		log.Printf("codex notice spool: %v", err)
		return false
	}
	return true
}

// Existing managed sessions can continue using an older helper binary. Observe
// their snapshots even while Hub is offline, without touching their processes.
func (a *Agent) collectCodexNotices(ctx context.Context) {
	previous := map[string]protocol.CodexObservation{}
	baselineDir := filepath.Join(a.sessions.dir, "codex-notification-baselines")
	collect := func() {
		entries, _ := os.ReadDir(filepath.Join(a.sessions.dir, "codex-events"))
		for _, entry := range entries {
			id := strings.TrimSuffix(entry.Name(), ".json")
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !validID(id) {
				continue
			}
			b, err := os.ReadFile(codexEventPath(a.sessions.dir, id))
			if err != nil {
				continue
			}
			var o protocol.CodexObservation
			if json.Unmarshal(b, &o) != nil || o.EventID == "" {
				continue
			}
			old, ok := previous[id]
			if !ok {
				if b, err := os.ReadFile(filepath.Join(baselineDir, id+".json")); err == nil && json.Unmarshal(b, &old) == nil {
					ok = true
				}
			}
			if ok && old.EventID != o.EventID && !spoolCodexNotice(a.sessions.dir, id, o, old) {
				continue
			}
			if !ok || !sameNoticeState(old, o) {
				o.LaunchCommand, o.ProcessKey = "", ""
				if err := os.MkdirAll(baselineDir, 0700); err != nil {
					continue
				}
				if err := atomicJSON(filepath.Join(baselineDir, id+".json"), o); err != nil {
					continue
				}
				previous[id] = o
			} else {
				previous[id] = old
			}
		}
	}
	collect()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			collect()
		}
	}
}

func (a *Agent) sendCodexNotices(ctx context.Context, socket *protocol.Socket) {
	send := func() bool {
		entries, _ := os.ReadDir(noticeDir(a.sessions.dir))
		n := 0
		for _, entry := range entries {
			key := strings.TrimSuffix(entry.Name(), ".json")
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !validNoticeID(key) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(noticeDir(a.sessions.dir), entry.Name()))
			if err != nil || len(b) > 16384 {
				continue
			}
			var notice codexNotice
			if json.Unmarshal(b, &notice) != nil || !validID(notice.TerminalID) {
				continue
			}
			if actual, _ := protocol.CodexNotice(notice.TerminalID, &notice.Observation); actual != key {
				continue
			}
			if err = socket.JSON(protocol.Message{Type: "codex.notice", RequestID: key, TerminalID: notice.TerminalID, Codex: &notice.Observation}); err != nil {
				socket.Close()
				return false
			}
			n++
			if n >= 32 {
				break
			}
		}
		return true
	}
	if !send() {
		return
	}
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !send() {
				return
			}
		}
	}
}

func validNoticeID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && strings.ToLower(id) == id
}

func (a *Agent) ackCodexNotice(id string) {
	if validNoticeID(id) {
		_ = os.Remove(filepath.Join(noticeDir(a.sessions.dir), id+".json"))
	}
}
