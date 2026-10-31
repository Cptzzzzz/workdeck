package hub

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/fileprotocol"
	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func TestDownloadRange(t *testing.T) {
	for _, tc := range []struct {
		header           string
		size, start, end int64
		ok               bool
	}{
		{"bytes=5-", 10, 5, 10, true}, {"bytes=1-3", 10, 1, 4, true}, {"bytes=1-999", 10, 1, 10, true},
		{"bytes=-3", 10, 7, 10, true}, {"bytes=-99", 10, 0, 10, true}, {"bytes=-0", 10, 0, 0, false},
		{"bytes=10-", 10, 0, 0, false}, {"bytes=+1-", 10, 0, 0, false}, {"bytes=1-2,4-5", 10, 0, 0, false},
		{"bytes=0-", 0, 0, 0, false}, {"bytes=5-4", 10, 0, 0, false}, {"bytes=-", 10, 0, 0, false},
	} {
		a, b, ok := downloadRange(tc.header, tc.size)
		if a != tc.start || b != tc.end || ok != tc.ok {
			t.Errorf("%q: got %d,%d,%v", tc.header, a, b, ok)
		}
	}
}

func TestDownloadStreamsAuthenticatedFileAndRejectsReplay(t *testing.T) {
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
	peers := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e == nil {
			peers <- c
		}
	}))
	defer srv.Close()
	control, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-peers
	defer peer.Close()
	defer control.Close()
	x.h.mu.Lock()
	x.h.agents[node] = &agentConn{socket: &protocol.Socket{Conn: control}, nodeID: node}
	x.h.mu.Unlock()
	defer func() { x.h.mu.Lock(); delete(x.h.agents, node); x.h.mu.Unlock() }()
	base := "/api/workspaces/" + record.ID
	version := strings.Repeat("a", 64)
	content := bytes.Repeat([]byte("safe data\n"), 8000)
	body := map[string]any{"path": "nested/file.txt", "version": version, "size": len(content)}
	if code, _ := x.request(t, "POST", base+"/downloads", body, false); code != 403 {
		t.Fatalf("missing csrf: %d", code)
	}
	if code, _ := x.request(t, "POST", base+"/downloads", map[string]any{"path": "../outside", "version": version, "size": 1}, true); code != 400 {
		t.Fatalf("escape path: %d", code)
	}
	code, out := x.request(t, "POST", base+"/downloads", body, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	token := out["ticket"].(string)
	guest, err := http.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	guest.Body.Close()
	if guest.StatusCode != 401 {
		t.Fatalf("anonymous ticket: %d", guest.StatusCode)
	}
	jar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: jar}
	loginBody := fmt.Sprintf(`{"username":"admin","password":%q}`, x.password)
	loginReq, _ := http.NewRequest("POST", x.s.URL+"/api/login", strings.NewReader(loginBody))
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Origin", x.s.URL)
	loginRes, err := other.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	loginRes.Body.Close()
	if loginRes.StatusCode != 200 {
		t.Fatalf("second login: %d", loginRes.StatusCode)
	}
	otherRes, err := other.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	otherRes.Body.Close()
	if otherRes.StatusCode != 403 {
		t.Fatalf("different login: %d", otherRes.StatusCode)
	}
	workerDone := make(chan error, 1)
	go func() { workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, version, content, nil) }()
	res, err := x.client.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || !bytes.Equal(got, content) {
		t.Fatalf("stream: %d %d %v", res.StatusCode, len(got), err)
	}
	if !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment;") || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers: %v", res.Header)
	}
	if res.Header.Get("Accept-Ranges") != "bytes" || res.Header.Get("ETag") != `"`+version+`"` {
		t.Fatalf("resume headers: %v", res.Header)
	}
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
	res, err = x.client.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("replayed ticket: %d", res.StatusCode)
	}
	resumeURL := x.s.URL + base + "/downloads/" + token
	requestRange := func(client *http.Client, header, match string) *http.Response {
		t.Helper()
		req, e := http.NewRequest("GET", resumeURL, nil)
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Range", header)
		if match != "" {
			req.Header.Set("If-Range", match)
		}
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		return response
	}
	res = requestRange(other, "bytes=100-", `"`+version+`"`)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("different login resume: %d", res.StatusCode)
	}
	res = requestRange(x.client, "bytes=invalid-", "")
	res.Body.Close()
	if res.StatusCode != 416 {
		t.Fatalf("invalid range: %d", res.StatusCode)
	}
	res = requestRange(x.client, "bytes=100-", `"different"`)
	res.Body.Close()
	if res.StatusCode != 412 {
		t.Fatalf("wrong if-range: %d", res.StatusCode)
	}
	go func() { workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, version, content, nil) }()
	res = requestRange(x.client, "bytes=100-", `"`+version+`"`)
	got, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 206 || !bytes.Equal(got, content[100:]) || res.Header.Get("Content-Range") != fmt.Sprintf("bytes 100-%d/%d", len(content)-1, len(content)) {
		t.Fatalf("resume: %d %d %v %v", res.StatusCode, len(got), err, res.Header)
	}
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
	go func() {
		workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, strings.Repeat("b", 64), content, nil)
	}()
	res = requestRange(x.client, "bytes=100-", `"`+version+`"`)
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("changed resume version: %d", res.StatusCode)
	}
	<-workerDone
	code, out = x.request(t, "POST", base+"/downloads", body, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	token = out["ticket"].(string)
	resumeURL = x.s.URL + base + "/downloads/" + token
	interrupt := make(chan struct{})
	go func() { workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, version, content, interrupt) }()
	res, err = x.client.Get(resumeURL)
	if err != nil {
		t.Fatal(err)
	}
	firstPart := make([]byte, fileprotocol.MaxChunk)
	if _, err = io.ReadFull(res.Body, firstPart); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	close(interrupt)
	<-workerDone
	go func() { workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, version, content, nil) }()
	res = requestRange(x.client, fmt.Sprintf("bytes=%d-", len(firstPart)), `"`+version+`"`)
	rest, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 206 || !bytes.Equal(append(firstPart, rest...), content) {
		t.Fatalf("interrupted resume: %d %v", res.StatusCode, err)
	}
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
	code, out = x.request(t, "POST", base+"/downloads", body, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	token = out["ticket"].(string)
	go func() {
		workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, strings.Repeat("b", 64), content, nil)
	}()
	res, err = x.client.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("changed version: %d", res.StatusCode)
	}
	<-workerDone
	code, out = x.request(t, "POST", base+"/downloads", body, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	token = out["ticket"].(string)
	pause := make(chan struct{})
	go func() { workerDone <- fakeDownloadAgent(x, peer, node, key, record.ID, version, content, pause) }()
	res, err = x.client.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, fileprotocol.MaxChunk)
	if _, err = io.ReadFull(res.Body, first); err != nil {
		t.Fatal(err)
	}
	if code, _ = x.request(t, "POST", "/api/logout", nil, true); code != 200 {
		t.Fatal(code)
	}
	close(pause)
	_, readErr := io.ReadAll(res.Body)
	res.Body.Close()
	if readErr == nil {
		t.Fatal("logout did not interrupt the download")
	}
	<-workerDone
	otherRes, err = other.Get(x.s.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	otherRes.Body.Close()
	if otherRes.StatusCode != 200 {
		t.Fatalf("other login revoked: %d", otherRes.StatusCode)
	}
	x.signIn(t)
	res = requestRange(x.client, "bytes=100-", `"`+version+`"`)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("logged-out resume: %d", res.StatusCode)
	}
	code, out = x.request(t, "POST", base+"/downloads", body, true)
	if code != 200 {
		t.Fatal(code, out)
	}
	token = out["ticket"].(string)
	if code, _ = x.request(t, "POST", "/api/logout", nil, true); code != 200 {
		t.Fatal(code)
	}
	x.signIn(t)
	res, err = x.client.Get(x.s.URL + base + "/downloads/" + token)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("logout ticket: %d", res.StatusCode)
	}
}

func fakeDownloadAgent(x *testHub, peer *websocket.Conn, node string, key ed25519.PrivateKey, workspace, version string, content []byte, pause <-chan struct{}) error {
	var attach protocol.Message
	if err := peer.ReadJSON(&attach); err != nil {
		return err
	}
	url := x.s.URL + "/api/agent/files"
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-Workdeck-Node", node)
	req.Header.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Workdeck-Nonce", randomID())
	req.Header.Set("X-Workdeck-Ticket", attach.Ticket)
	req.Header.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(signaturePayload(req)))))
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http"), req.Header)
	if err != nil {
		return err
	}
	defer conn.Close()
	send := func(id, typ string, value any) error {
		payload, _ := json.Marshal(map[string]any{"result": value})
		frame, err := fileprotocol.EncodeControl(fileprotocol.Envelope{Version: 1, Type: typ, RequestID: id, WorkspaceID: workspace, RootRevision: 1, RouteEpoch: 1, Payload: payload})
		if err != nil {
			return err
		}
		return conn.WriteMessage(websocket.TextMessage, frame)
	}
	if err := send(files.NewID(time.Now()), "file.ready", map[string]any{}); err != nil {
		return err
	}
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	open, err := fileprotocol.DecodeControl(raw)
	if err != nil || open.Type != "file.read.open" {
		return fmt.Errorf("invalid open: %v", err)
	}
	if err = send(open.RequestID, "result", files.Entry{Name: "file.txt", Kind: "file", Size: int64(len(content)), Version: version}); err != nil {
		return err
	}
	for offset := -1; offset < len(content); {
		_, raw, err = conn.ReadMessage()
		if err != nil {
			return err
		}
		request, err := fileprotocol.DecodeControl(raw)
		if err != nil || request.Type != "file.read.chunk" {
			return fmt.Errorf("invalid chunk: %v", err)
		}
		var p struct {
			ReadID string `json:"read_id"`
			Offset int    `json:"offset"`
			Length int    `json:"length"`
		}
		if json.Unmarshal(request.Payload, &p) != nil {
			return fmt.Errorf("invalid range payload")
		}
		if offset == -1 {
			offset = p.Offset
		}
		if p.ReadID != open.RequestID || p.Offset != offset || offset < 0 || p.Length < 1 || p.Length > fileprotocol.MaxChunk || p.Length > len(content)-offset {
			return fmt.Errorf("invalid range")
		}
		frame, err := fileprotocol.EncodeChunk(fileprotocol.Chunk{Kind: fileprotocol.DownloadChunk, RequestID: request.RequestID, Offset: int64(offset), RouteEpoch: 1, Data: content[offset : offset+p.Length]})
		if err != nil {
			return err
		}
		if err = conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			return err
		}
		if err = send(request.RequestID, "result", map[string]any{"bytes": p.Length}); err != nil {
			return err
		}
		offset += p.Length
		if pause != nil {
			<-pause
			pause = nil
		}
	}
	return nil
}
