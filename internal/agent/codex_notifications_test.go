package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"workdeck/internal/protocol"
)

func TestOldManagedSessionIsObservedAcrossAgentRestart(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("a", 48)
	if e := os.MkdirAll(filepath.Join(dir, "codex-events"), 0700); e != nil {
		t.Fatal(e)
	}
	running := protocol.CodexObservation{Managed: true, ThreadID: "thread", Status: "goal_active", EventID: "running", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Goal: &protocol.CodexGoal{Status: "active", CreatedAt: 123}}
	if e := atomicJSON(codexEventPath(dir, id), running); e != nil {
		t.Fatal(e)
	}
	a := &Agent{sessions: &Sessions{dir: dir}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.collectCodexNotices(ctx) }()
	baseline := filepath.Join(dir, "codex-notification-baselines", id+".json")
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, e := os.Stat(baseline); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("baseline not recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	completed := running
	completed.Status = "goal_complete"
	completed.EventID = "completed"
	completed.Goal = &protocol.CodexGoal{Status: "complete", CreatedAt: 123, UpdatedAt: 130}
	completed.TurnStartedAt = 125
	completed.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if e := atomicJSON(codexEventPath(dir, id), completed); e != nil {
		t.Fatal(e)
	}
	ctx, cancel = context.WithCancel(context.Background())
	done = make(chan struct{})
	go func() { defer close(done); a.collectCodexNotices(ctx) }()
	key, _ := protocol.CodexNotice(id, &completed)
	path := filepath.Join(noticeDir(dir), key+".json")
	deadline = time.Now().Add(3 * time.Second)
	for {
		if _, e := os.Stat(path); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completion during agent restart was not spooled")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
}

func TestCodexNotificationSpoolPersistsUntilAcknowledged(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("a", 48)
	before := protocol.CodexObservation{Managed: true, ThreadID: "thread", Status: "goal_active", EventID: "before"}
	after := protocol.CodexObservation{Managed: true, ThreadID: "thread", Status: "goal_complete", EventID: "after", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), LaunchCommand: "private-command", Goal: &protocol.CodexGoal{Status: "complete", CreatedAt: 123}}
	spoolCodexNotice(dir, id, after, before)
	key, _ := protocol.CodexNotice(id, &after)
	path := filepath.Join(noticeDir(dir), key+".json")
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "private-command") {
		t.Fatal("spool exposed launch command")
	}
	var event codexNotice
	if e = json.Unmarshal(b, &event); e != nil || event.TerminalID != id {
		t.Fatal(e)
	}
	a := &Agent{sessions: &Sessions{dir: dir}}
	a.ackCodexNotice("../../not-valid")
	if _, e = os.Stat(path); e != nil {
		t.Fatal("invalid ack removed event", e)
	}
	a.ackCodexNotice(key)
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("ack did not remove event", e)
	}
}
