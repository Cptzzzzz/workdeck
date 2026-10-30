package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

func TestRouteFencePausesOutputUntilMatchingCommit(t *testing.T) {
	serverSide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			serverSide <- conn
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn := <-serverSide
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := &terminalLink{ctx: ctx, cancel: cancel, ws: &protocol.Socket{Conn: conn}, active: "relay"}
	if err = l.write(websocket.BinaryMessage, []byte("before")); err != nil {
		t.Fatal(err)
	}
	if _, data, err := client.ReadMessage(); err != nil || string(data) != "before" {
		t.Fatalf("old output lost: %q %v", data, err)
	}
	if err = l.requestRoute("relay", protocol.Frame{ID: "fence", Route: "relay"}); err != nil {
		t.Fatal(err)
	}
	var frame protocol.Frame
	if err = client.ReadJSON(&frame); err != nil || frame.Type != "route-ready" {
		t.Fatalf("missing output fence: %+v %v", frame, err)
	}
	written := make(chan error, 1)
	go func() { written <- l.write(websocket.BinaryMessage, []byte("after")) }()
	if err = l.commitRoute("relay", protocol.Frame{ID: "wrong-id"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-written:
		t.Fatal("uncommitted switch let new output pass")
	case <-time.After(50 * time.Millisecond):
	}
	if err = l.commitRoute("relay", protocol.Frame{ID: "fence"}); err != nil {
		t.Fatal(err)
	}
	if err = client.ReadJSON(&frame); err != nil || frame.Type != "route-active" {
		t.Fatalf("missing commit acknowledgment: %+v %v", frame, err)
	}
	if _, data, err := client.ReadMessage(); err != nil || string(data) != "after" {
		t.Fatalf("new output lost: %q %v", data, err)
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	cancel()
	if l.accepts("relay") {
		t.Fatal("canceled attachment still accepts input")
	}
}

func TestControllerTicketAlsoGatesDirectInput(t *testing.T) {
	a := &Agent{controllers: map[string]string{"terminal": "new-ticket"}}
	for _, msg := range []protocol.Message{
		{TerminalID: "terminal", Ticket: "old-ticket"},
		{TerminalID: "terminal", Ticket: "new-ticket", ReadOnly: true},
		{TerminalID: "unknown"},
	} {
		if a.isController(msg) {
			t.Fatal("stale or readonly viewer acquired control")
		}
	}
	if !a.isController(protocol.Message{TerminalID: "terminal", Ticket: "new-ticket"}) {
		t.Fatal("current controller rejected")
	}
}

func TestSpeculativeProbeFailureKeepsRelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := &terminalLink{ctx: ctx, cancel: cancel, active: "relay"}
	if err := l.probe("direct", protocol.Frame{ID: "optional-probe"}); err != nil {
		t.Fatalf("optional probe interrupted relay: %v", err)
	}
	if ctx.Err() != nil {
		t.Fatal("healthy relay attachment canceled")
	}
	l.active = "direct"
	if err := l.probe("direct", protocol.Frame{ID: "health-probe"}); err == nil {
		t.Fatal("failed active direct path was not detected")
	}
}
