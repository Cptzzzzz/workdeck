package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

func TestReconnectWithIdleResizedTerminal(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is required")
	}
	sessions, err := newSessions(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var bytes [24]byte
	_, _ = rand.Read(bytes[:])
	id := hex.EncodeToString(bytes[:])
	record := protocol.Session{ID: id, State: "running", RunUser: os.Getenv("WORKDECK_TEST_SESSION_OWNER")}
	// An optional different owner exercises the root Agent's runuser wrapper.
	command, err := sessionCommand(context.Background(), record, sessions.tmux, "-L", socketName(id), "-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 120")
	if err != nil {
		t.Fatal(err)
	}
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("start isolated tmux: %v: %s", err, out)
	}
	if err := atomicJSON(sessions.path(id), record); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = sessions.tmuxRun(id, "kill-server") })
	before, err := sessions.tmuxRun(id, "display-message", "-p", "-t", "main", "#{pane_pid}")
	if err != nil {
		t.Fatal(err)
	}
	controls := make(chan *websocket.Conn, 8)
	resized := make(chan struct{}, 8)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if strings.HasSuffix(r.URL.Path, "/control") {
			var inventory protocol.Message
			if conn.ReadJSON(&inventory) != nil {
				return
			}
			controls <- conn
			_ = conn.WriteJSON(protocol.Message{Type: "attach", TerminalID: id, Ticket: "test"})
		} else {
			_ = conn.WriteJSON(protocol.Frame{Type: "resize", Cols: 90, Rows: 25})
			// A tmux redraw proves the resize has reached the idle attachment.
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			resized <- struct{}{}
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	a := &Agent{identity: Identity{Hub: server.URL, NodeID: id}, key: key, sessions: sessions}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			t.Error("Agent shutdown blocked on terminal cleanup")
		}
	}()
	// Repeated control disconnects reproduce deployment/restart without killing
	// the Agent. Quiet terminals must never hold up its next control connection.
	for i := 0; i < 3; i++ {
		var control *websocket.Conn
		select {
		case control = <-controls:
		case <-time.After(10 * time.Second):
			t.Fatal("Agent did not reconnect")
		}
		select {
		case <-resized:
		case <-time.After(5 * time.Second):
			t.Fatal("terminal attachment did not produce output")
		}
		_ = control.Close()
	}
	select {
	case <-controls:
	case <-time.After(10 * time.Second):
		t.Fatal("Agent remained offline after terminal disconnect")
	}
	after, err := sessions.tmuxRun(id, "display-message", "-p", "-t", "main", "#{pane_pid}")
	if err != nil || string(before) != string(after) {
		t.Fatalf("persistent terminal changed during reconnect: %q -> %q (%v)", before, after, err)
	}
}

func TestStopUnresponsiveAttachment(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "trap '' HUP TERM; printf ready; while :; do sleep 1; done")
	f, err := startAttachment(cmd)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.SetReadDeadline(time.Now().Add(5 * time.Second))
	var ready [5]byte
	if _, err := f.Read(ready[:]); err != nil {
		stopAttachment(cmd, f)
		t.Fatal(err)
	}
	start := time.Now()
	stopAttachment(cmd, f)
	if time.Since(start) > 4*time.Second {
		t.Fatal("attachment cleanup exceeded its deadline")
	}
}
