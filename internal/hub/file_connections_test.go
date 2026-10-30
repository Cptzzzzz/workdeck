package hub

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func TestFileRelayTicketAndLogoutRevocation(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	node, terminal := randomID(), randomID()
	if _, err = x.h.store.db.Exec(`INSERT INTO nodes(id,name,public_key,capabilities) VALUES(?,?,?,?)`, node, "fixture", base64.StdEncoding.EncodeToString(pub), `["workspace-control-v1","workspace-files-v1"]`); err != nil {
		t.Fatal(err)
	}
	if _, err = x.h.store.db.Exec(`INSERT INTO terminals(id,node_id,name,cwd,desired_state,observed_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, terminal, node, "fixture", "/fixture", "running", "running", now(), now()); err != nil {
		t.Fatal(err)
	}
	record, err := x.h.store.reserveWorkspace(t.Context(), terminal)
	if err != nil {
		t.Fatal(err)
	}
	if err = x.h.store.confirmWorkspace(t.Context(), files.Workspace{ID: record.ID, TerminalID: terminal, Root: "/fixture", Revision: 1, User: "fixture", Device: 1, Inode: 1}); err != nil {
		t.Fatal(err)
	}
	peerCh := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e == nil {
			peerCh <- c
		}
	}))
	defer server.Close()
	control, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-peerCh
	defer peer.Close()
	defer control.Close()
	x.h.mu.Lock()
	x.h.agents[node] = &agentConn{socket: &protocol.Socket{Conn: control}, nodeID: node}
	x.h.mu.Unlock()
	defer func() { x.h.mu.Lock(); delete(x.h.agents, node); x.h.mu.Unlock() }()
	path := "/api/workspaces/" + record.ID
	if code, _ := x.request(t, "POST", path+"/connections", map[string]any{}, false); code != 403 {
		t.Fatal("missing csrf accepted", code)
	}
	code, out := x.request(t, "POST", path+"/connections", map[string]any{}, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	ticket := out["ticket"].(string)
	u, _ := url.Parse(x.s.URL)
	headers := http.Header{"Origin": []string{x.s.URL}}
	for _, cookie := range x.client.Jar.Cookies(u) {
		headers.Add("Cookie", cookie.Name+"="+cookie.Value)
	}
	dialer := websocket.Dialer{Subprotocols: []string{fileTicketProtocol + ticket}}
	browser, resp, err := dialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+path+"/ws", headers)
	if err != nil {
		t.Fatal(err, resp)
	}
	defer browser.Close()
	var attach protocol.Message
	peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err = peer.ReadJSON(&attach); err != nil {
		t.Fatal(err)
	}
	if attach.Type != "file.attach" || attach.WorkspaceID != record.ID || attach.RootRevision != 1 || attach.Ticket == ticket {
		t.Fatal("invalid agent attachment")
	}
	agentURL := x.s.URL + "/api/agent/files"
	req, _ := http.NewRequest("GET", agentURL, nil)
	req.Header.Set("X-Workdeck-Node", node)
	req.Header.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Workdeck-Nonce", randomID())
	req.Header.Set("X-Workdeck-Ticket", attach.Ticket)
	req.Header.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(signaturePayload(req)))))
	agent, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(agentURL, "http"), req.Header)
	if err != nil {
		t.Fatal(err, resp)
	}
	defer agent.Close()
	if err = browser.WriteMessage(websocket.TextMessage, []byte("browser")); err != nil {
		t.Fatal(err)
	}
	agent.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, message, err := agent.ReadMessage()
	if err != nil || string(message) != "browser" {
		t.Fatal(string(message), err)
	}
	if err = agent.WriteMessage(websocket.BinaryMessage, []byte("node")); err != nil {
		t.Fatal(err)
	}
	browser.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, message, err = browser.ReadMessage()
	if err != nil || string(message) != "node" {
		t.Fatal(string(message), err)
	}
	_, replay, err := dialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+path+"/ws", headers)
	if err == nil || replay == nil || replay.StatusCode != 403 {
		t.Fatal("replayed ticket accepted", err, replay)
	}
	replay.Body.Close()
	// An unconsumed ticket is revoked at logout, as is the live relay.
	code, out = x.request(t, "POST", path+"/connections", map[string]any{}, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	otherTicket := out["ticket"].(string)
	if code, _ = x.request(t, "POST", "/api/logout", map[string]any{}, true); code != 200 {
		t.Fatal(code)
	}
	browser.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err = browser.ReadMessage(); err == nil {
		t.Fatal("connection survived logout")
	}
	x.h.mu.Lock()
	_, exists := x.h.fileTickets[digest(otherTicket)]
	x.h.mu.Unlock()
	if exists {
		t.Fatal("ticket survived logout")
	}
	if state, err := x.h.store.terminal(terminal); err != nil || state.Desired != "running" {
		t.Fatal(fmt.Sprint(state), err)
	}
}

func TestNodeRevocationCancelsFileLeases(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node := randomID()
	if _, err := x.h.store.db.Exec(`INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)`, node, "fixture", "key"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	x.h.mu.Lock()
	x.h.fileConnections = map[string]*fileConnection{"test": {nodeID: node, cancel: cancel}}
	x.h.fileTickets = map[string]*fileBrowserTicket{"test": {nodeID: node}}
	x.h.mu.Unlock()
	if code, _ := x.request(t, "DELETE", "/api/nodes/"+node, map[string]any{}, true); code != 200 {
		t.Fatal(code)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("node revocation did not cancel file lease")
	}
	x.h.mu.Lock()
	_, exists := x.h.fileTickets["test"]
	x.h.mu.Unlock()
	if exists {
		t.Fatal("node ticket survived revocation")
	}
}
