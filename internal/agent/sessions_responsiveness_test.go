package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workdeck/internal/protocol"
)

func TestSlowInventoryDoesNotBlockAttachmentOrOverwriteClose(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	slow, fast := strings.Repeat("a", 48), strings.Repeat("b", 48)
	started, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	tmux := filepath.Join(dir, "tmux")
	script := "#!/bin/sh\n" +
		"if [ \"$2\" = workdeck-" + slow + " ] && [ \"$3\" = display-message ]; then\n" +
		" touch '" + started + "'\n while [ ! -e '" + release + "' ]; do sleep .02; done\nfi\n" +
		"if [ \"$3\" = display-message ]; then echo '0:0:123'; fi\n"
	if err := os.WriteFile(tmux, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	s := &Sessions{dir: dir, tmux: tmux}
	for _, id := range []string{slow, fast} {
		if err := atomicJSON(s.path(id), protocol.Session{ID: id, State: "running"}); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0600) })
	done := make(chan error, 1)
	go func() { _, err := s.Inventory(); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("inventory did not begin slow inspection")
		}
		time.Sleep(10 * time.Millisecond)
	}
	attached := make(chan error, 1)
	go func() { _, err := s.AttachCommand(fast, false); attached <- err }()
	select {
	case err := <-attached:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("slow inventory blocked attachment of another terminal")
	}
	s.mu.Lock()
	closed := protocol.Session{ID: slow, State: "closed"}
	err := atomicJSON(s.path(slow), closed)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("inventory did not finish")
	}
	got, err := s.read(slow)
	if err != nil || got.State != "closed" {
		t.Fatalf("inventory overwrote concurrent close: %+v, %v", got, err)
	}
	// The Agent's publication lock must also stay free while tmux is slow.
	// An inventory invalidated by a concurrent mutation must not be sent.
	if err := os.Remove(started); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(release); err != nil {
		t.Fatal(err)
	}
	if err := atomicJSON(s.path(slow), protocol.Session{ID: slow, State: "running"}); err != nil {
		t.Fatal(err)
	}
	a := &Agent{sessions: s}
	published := make(chan error, 1)
	go func() { published <- a.inventory(context.Background(), nil) }()
	deadline = time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent inventory did not begin")
		}
		time.Sleep(10 * time.Millisecond)
	}
	changed := make(chan struct{})
	go func() { a.stateMu.Lock(); a.stateVersion++; a.stateMu.Unlock(); close(changed) }()
	select {
	case <-changed:
	case <-time.After(2 * time.Second):
		t.Fatal("inventory blocked an Agent state change")
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-published:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("invalidated inventory did not finish")
	}
}
