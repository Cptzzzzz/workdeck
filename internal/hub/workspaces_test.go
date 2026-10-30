package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func TestWorkspaceAPIAndLostCommitAcknowledgement(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node, terminal := randomID(), randomID()
	if _, err := x.h.store.db.Exec(`INSERT INTO nodes(id,name,public_key,capabilities) VALUES(?,?,?,?)`, node, "fixture", "key", `["workspace-control-v1"]`); err != nil {
		t.Fatal(err)
	}
	root, next := t.TempDir(), t.TempDir()
	if _, err := x.h.store.db.Exec(`INSERT INTO terminals(id,node_id,name,cwd,desired_state,observed_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, terminal, node, "fixture", root, "running", "running", now(), now()); err != nil {
		t.Fatal(err)
	}
	engine, err := files.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	// A private WebSocket pair exercises the real Hub command dispatch while
	// the test-only node uses an isolated on-disk file engine.
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
	socket := &protocol.Socket{Conn: client}
	x.h.mu.Lock()
	x.h.agents[node] = &agentConn{socket: socket, nodeID: node}
	x.h.mu.Unlock()
	defer func() { x.h.mu.Lock(); delete(x.h.agents, node); x.h.mu.Unlock(); socket.Close(); peer.Close() }()
	var drop atomic.Bool
	var dropRegistration atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			var msg protocol.Message
			if peer.ReadJSON(&msg) != nil {
				return
			}
			reply := protocol.Message{Type: "result", RequestID: msg.RequestID}
			switch msg.Type {
			case "workspace.register":
				spec, e := engine.RegisterWorkspace(context.Background(), files.Workspace{ID: msg.WorkspaceID, TerminalID: terminal, Root: root, Revision: 1})
				if e != nil {
					reply.Error = e.Error()
					reply.ErrorCode = files.ErrorCode(e)
				} else {
					reply.Workspace = &spec
				}
				if dropRegistration.Swap(false) {
					continue
				}
			case "workspace.prepare":
				change, e := engine.PrepareRootChange(context.Background(), msg.WorkspaceID, msg.RootRevision, msg.OperationID, msg.Path)
				if e != nil {
					reply.Error = e.Error()
					reply.ErrorCode = files.ErrorCode(e)
				} else {
					reply.RootChange = &change
				}
			case "workspace.commit":
				change, e := engine.CommitRootChange(context.Background(), msg.WorkspaceID, msg.OperationID)
				if e != nil {
					reply.Error = e.Error()
					reply.ErrorCode = files.ErrorCode(e)
				} else {
					reply.RootChange = &change
				}
				if drop.Swap(false) {
					continue
				}
			case "workspace.status":
				change, e := engine.RootChangeStatus(context.Background(), msg.WorkspaceID, msg.OperationID)
				if e != nil {
					reply.Error = e.Error()
					reply.ErrorCode = files.ErrorCode(e)
				} else {
					reply.RootChange = &change
				}
			case "workspace.abort":
				change, e := engine.AbortRootChange(context.Background(), msg.WorkspaceID, msg.OperationID)
				if e != nil {
					reply.Error = e.Error()
					reply.ErrorCode = files.ErrorCode(e)
				} else {
					reply.RootChange = &change
				}
			}
			// Deliver as the authenticated control loop would; no test traffic reaches a production Agent.
			x.h.mu.Lock()
			waiter, ok := x.h.requests[reply.RequestID]
			x.h.mu.Unlock()
			if ok {
				waiter.ch <- reply
			}
		}
	}()
	defer func() { peer.Close(); <-done }()
	path := "/api/terminals/" + terminal + "/workspace"
	if code, out := x.request(t, "GET", path, nil, false); code != 200 || out["initialized"] != false {
		t.Fatal(code, out)
	}
	if code, _ := x.request(t, "POST", path, nil, false); code != 403 {
		t.Fatal("missing CSRF accepted", code)
	}
	record, err := x.h.store.reserveWorkspace(context.Background(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	dropRegistration.Store(true)
	initialCtx, initialCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	err = x.h.initializeWorkspace(initialCtx, record)
	initialCancel()
	if err == nil {
		t.Fatal("lost registration acknowledgement unexpectedly succeeded")
	}
	x.h.scheduleWorkspaceRecovery(node)
	initialDeadline := time.Now().Add(5 * time.Second)
	for {
		record, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
		if err == nil && record.State == "ready" {
			break
		}
		if time.Now().After(initialDeadline) {
			t.Fatalf("background initialization failed: %+v %v", record, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if code, out := x.request(t, "POST", path, map[string]any{}, true); code != 200 || out["state"] != "ready" {
		t.Fatal(code, out)
	}
	record, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	op := files.NewID(time.Now())
	if err = x.h.store.beginWorkspaceChange(context.Background(), record.ID, 1, op, next); err != nil {
		t.Fatal(err)
	}
	record, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	drop.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err = x.h.recoverWorkspaceChange(ctx, record); err == nil {
		t.Fatal("lost acknowledgement unexpectedly succeeded")
	}
	pending, err := x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil || pending.State != "changing" || pending.PendingCandidate == "" {
		t.Fatal(pending, err)
	}
	code, out := x.request(t, "PUT", path, map[string]any{"root_path": next, "root_revision": 1}, true)
	if code != 200 || out["state"] != "ready" {
		t.Fatal(code, out)
	}
	restored, err := x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil || restored.Root != next || restored.Revision != 2 {
		t.Fatal(restored, err)
	}
	if code, _ = x.request(t, "PUT", path, map[string]any{"root_path": root, "root_revision": 1}, true); code != 409 {
		t.Fatal("stale revision accepted", code)
	}
	secondOp := files.NewID(time.Now())
	if err = x.h.store.beginWorkspaceChange(context.Background(), record.ID, 2, secondOp, root); err != nil {
		t.Fatal(err)
	}
	pending, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	drop.Store(true)
	short, stop := context.WithTimeout(context.Background(), 300*time.Millisecond)
	err = x.h.recoverWorkspaceChange(short, pending)
	stop()
	if err == nil {
		t.Fatal("second lost acknowledgement unexpectedly succeeded")
	}
	x.h.scheduleWorkspaceRecovery(node)
	deadline := time.Now().Add(5 * time.Second)
	for {
		restored, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
		if err == nil && restored.State == "ready" && restored.Revision == 3 && restored.Root == root {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background recovery failed: %+v %v", restored, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A pending upload must not strand the old revision after connections are
	// revoked for a requested switch. The confirmed abort restores access so
	// the user can resume or cancel that upload.
	body := []byte("pending")
	sum := sha256.Sum256(body)
	upload := files.NewID(time.Now())
	if _, err = engine.BeginWrite(context.Background(), record.ID, 3, upload, files.WriteSpec{Path: "pending.txt", Create: true, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}); err != nil {
		t.Fatal(err)
	}
	thirdOp := files.NewID(time.Now())
	if err = x.h.store.beginWorkspaceChange(context.Background(), record.ID, 3, thirdOp, next); err != nil {
		t.Fatal(err)
	}
	pending, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	if err = x.h.recoverWorkspaceChange(context.Background(), pending); err == nil {
		t.Fatal("pending upload did not prevent root switch")
	}
	restored, err = x.h.store.workspaceByTerminal(context.Background(), terminal)
	if err != nil || restored.State != "ready" || restored.Revision != 3 {
		t.Fatalf("old workspace remained blocked: %+v %v", restored, err)
	}
	if _, err = engine.Abort(context.Background(), record.ID, 3, upload); err != nil {
		t.Fatal(err)
	}
}
