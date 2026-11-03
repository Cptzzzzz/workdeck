package hub

import (
	"context"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"workdeck/internal/protocol"
)

func TestCodexHistoryRouteDispatchAndCapability(t *testing.T) {
	x := setup(t)
	node := randomID()
	path := "/api/nodes/" + node + "/codex-history?cwd=" + url.QueryEscape("/workspace/project with spaces") + "&cursor=older"
	if code, _ := x.request(t, "GET", path, nil, false); code != 401 {
		t.Fatal("history is public", code)
	}
	x.signIn(t)
	_, _ = x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key,capabilities) VALUES(?,?,?,?)", node, "fixture", "key", `["codex-history-v1"]`)
	if code, _ := x.request(t, "GET", path, nil, false); code != 409 {
		t.Fatal("offline node accepted", code)
	}
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e == nil {
			accepted <- c
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	x.h.mu.Lock()
	x.h.agents[node] = &agentConn{socket: &protocol.Socket{Conn: client}, nodeID: node}
	x.h.mu.Unlock()
	defer func() { x.h.mu.Lock(); delete(x.h.agents, node); x.h.mu.Unlock(); client.Close(); peer.Close() }()
	done := make(chan struct{})
	go func() {
		defer close(done)
		var msg protocol.Message
		if peer.ReadJSON(&msg) != nil {
			return
		}
		if msg.Type != "codex.history" || msg.Path != "/workspace/project with spaces" || msg.CodexCursor != "older" {
			t.Error("invalid history dispatch")
		}
		x.h.mu.Lock()
		waiter, ok := x.h.requests[msg.RequestID]
		x.h.mu.Unlock()
		if ok {
			waiter.ch <- protocol.Message{Type: "result", RequestID: msg.RequestID, CodexHistory: &protocol.CodexHistory{Cwd: msg.Path, RunUser: "fixture", Entries: []protocol.CodexHistoryEntry{{ID: "thread", Title: "Saved task", Cwd: msg.Path}}}}
		}
	}()
	if code, value := x.request(t, "GET", path, nil, false); code != 200 || len(value["entries"].([]any)) != 1 {
		t.Fatal(code, value)
	}
	<-done
	_, _ = x.h.store.db.Exec("UPDATE nodes SET capabilities='[]' WHERE id=?", node)
	if code, _ := x.request(t, "GET", path, nil, false); code != 409 {
		t.Fatal("old agent not rejected", code)
	}
}

func TestCodexHistoryCancelledBrowserSignalsOnlyItsQuery(t *testing.T) {
	x := setup(t)
	node := randomID()
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e == nil {
			accepted <- c
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peer := <-accepted
	defer peer.Close()
	x.h.mu.Lock()
	x.h.agents[node] = &agentConn{socket: &protocol.Socket{Conn: client}, nodeID: node}
	x.h.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := x.h.command(ctx, node, protocol.Message{Type: "codex.history", Path: "/workspace"})
		done <- err
	}()
	peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	var request protocol.Message
	if err := peer.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	cancel()
	var cancelled protocol.Message
	if err := peer.ReadJSON(&cancelled); err != nil {
		t.Fatal("node did not receive cancellation", err)
	}
	if cancelled.Type != "codex.history.cancel" || cancelled.RequestID != request.RequestID {
		t.Fatal("wrong query cancelled")
	}
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("browser cancellation blocked")
	}
}
