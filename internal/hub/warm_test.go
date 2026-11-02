package hub

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
	"workdeck/internal/protocol"
)

func TestWarmTransportBindsWithoutNewAgentConnection(t *testing.T) {
	t.Run("websocket", func(t *testing.T) { testWarmTransport(t, false) })
	t.Run("http-stream", func(t *testing.T) { testWarmTransport(t, true) })
}
func testWarmTransport(t *testing.T, streaming bool) {
	x := setup(t)
	x.signIn(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	node, terminal := randomID(), randomID()
	_, err := x.h.store.db.Exec(`INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)`, node, "warm-test", base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatal(err)
	}
	_, err = x.h.store.db.Exec(`INSERT INTO terminals(id,node_id,name,cwd,desired_state,observed_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, terminal, node, "warm-test", "/tmp", "running", "running", now(), now())
	if err != nil {
		t.Fatal(err)
	}
	dialAgent := func(path string) *websocket.Conn {
		t.Helper()
		req, _ := http.NewRequest("GET", x.s.URL+path, nil)
		req.Header.Set("X-Workdeck-Node", node)
		req.Header.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
		req.Header.Set("X-Workdeck-Nonce", randomID())
		req.Header.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(signaturePayload(req)))))
		c, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+path, req.Header)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	control := dialAgent("/api/agent/control")
	var config protocol.Message
	if err = control.ReadJSON(&config); err != nil || config.WarmConnections != 2 {
		t.Fatal(err, config)
	}
	pool := []*websocket.Conn{dialAgent("/api/agent/standby"), dialAgent("/api/agent/standby")}
	deadline := time.Now().Add(time.Second)
	for {
		x.h.mu.Lock()
		a := x.h.agents[node]
		n := 0
		if a != nil {
			n = len(a.warm)
		}
		x.h.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pool not ready")
		}
		time.Sleep(time.Millisecond)
	}
	u, _ := url.Parse(x.s.URL)
	headers := http.Header{"Origin": []string{x.s.URL}}
	for _, c := range x.client.Jar.Cookies(u) {
		headers.Add("Cookie", c.Name+"="+c.Value)
	}
	loser, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+"/api/terminals/"+terminal+"/ws?deferred=1&takeover=1", headers)
	if e != nil {
		t.Fatal(e)
	}
	x.h.mu.Lock()
	owners := len(x.h.controllers)
	views := len(x.h.attachments)
	idle := len(x.h.agents[node].warm)
	x.h.mu.Unlock()
	if owners != 0 || views != 0 || idle != 2 {
		t.Fatal("unselected browser claimed terminal", owners, views, idle)
	}
	loser.Close()
	for i, agent := range pool {
		var browser testBrowser
		if streaming {
			browser = x.dialHTTPBrowser(t, "/api/terminals/"+terminal+"/stream?deferred=1")
		} else {
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+"/api/terminals/"+terminal+"/ws?deferred=1", headers)
			if err != nil {
				t.Fatal(err)
			}
			browser = ws
		}
		defer browser.Close()
		if e = browser.WriteJSON(protocol.Frame{Type: "start"}); e != nil {
			t.Fatal(e)
		}
		agent.SetReadDeadline(time.Now().Add(time.Second))
		var bind protocol.Message
		if e = agent.ReadJSON(&bind); e != nil {
			t.Fatal(e)
		}
		if bind.Type != "attach" || bind.TerminalID != terminal || bind.Ticket == "" || bind.ReadOnly != (i == 1) {
			t.Fatalf("unexpected bind: %s readonly=%v", bind.Type, bind.ReadOnly)
		}
		if e = agent.WriteJSON(protocol.Message{Type: "standby.bound"}); e != nil {
			t.Fatal(e)
		}
		if e = agent.WriteMessage(websocket.BinaryMessage, []byte("warm output")); e != nil {
			t.Fatal(e)
		}
		if c, ok := browser.(*websocket.Conn); ok {
			c.SetReadDeadline(time.Now().Add(time.Second))
		}
		var ready protocol.Frame
		if e = browser.ReadJSON(&ready); e != nil || ready.Type != "ready" || ready.ReadOnly != (i == 1) {
			t.Fatal(e, ready)
		}
		kind, data, e := browser.ReadMessage()
		if e != nil || kind != websocket.BinaryMessage || string(data) != "warm output" {
			t.Fatal("relay failed", e)
		}
		if streaming && i == 0 {
			stream := browser.(*testHTTPBrowser)
			if err := stream.send(2, []byte("echo from HTTP")); err != nil {
				t.Fatal(err)
			}
			kind, data, err := agent.ReadMessage()
			if err != nil || kind != 2 || string(data) != "echo from HTTP" {
				t.Fatal("HTTP input not relayed", err)
			}
			// Input endpoints are bound to the login which opened the stream.
			jar, _ := cookiejar.New(nil)
			other := &testHub{h: x.h, s: x.s, client: &http.Client{Jar: jar}, password: x.password}
			other.signIn(t)
			code, _ := other.request(t, "POST", "/api/terminal-streams/"+stream.id+"/input", map[string]any{"packets": []streamPacket{{2, []byte("foreign input")}}}, true)
			if code != 404 {
				t.Fatal("another valid login accessed stream", code)
			}

		}

	}
	if streaming {
		if code, _ := x.request(t, "POST", "/api/logout", nil, true); code != 200 {
			t.Fatal(code)
		}
	} else {
		control.Close()
	}
	for _, c := range pool {
		c.SetReadDeadline(time.Now().Add(time.Second))
		if _, _, e := c.ReadMessage(); e == nil {
			t.Fatal("pool survived control disconnect")
		}
	}
	if streaming {
		deadline := time.Now().Add(time.Second)
		for {
			x.h.mu.Lock()
			n := len(x.h.browserStreams)
			x.h.mu.Unlock()
			if n == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("HTTP stream registry leaked after logout")
			}
			time.Sleep(time.Millisecond)
		}
	}
	record, e := x.h.store.terminal(terminal)
	if e != nil || record.Desired != "running" {
		t.Fatal("disconnect closed persistent terminal", e)
	}
}

func TestTerminalStartupValidation(t *testing.T) {
	x := setup(t)
	v := map[string]any{"trace": "0123456789abcdef", "stage": "rendered", "elapsed_ms": 30, "open_ms": 10, "ready_ms": 20}
	if c, _ := x.request(t, "POST", "/api/terminal-startup", v, true); c != 401 {
		t.Fatal(c)
	}
	x.signIn(t)
	if c, _ := x.request(t, "POST", "/api/terminal-startup", v, false); c != 403 {
		t.Fatal(c)
	}
	if c, _ := x.request(t, "POST", "/api/terminal-startup", v, true); c != 200 {
		t.Fatal(c)
	}
	v["ready_ms"] = 40
	if c, _ := x.request(t, "POST", "/api/terminal-startup", v, true); c != 400 {
		t.Fatal(c)
	}
}
