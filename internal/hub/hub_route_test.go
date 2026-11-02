package hub

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

func TestControlPublishesTailnetHintToAuthenticatedNode(t *testing.T) {
	x := setup(t)
	x.h.cfg.TailnetProbeURL = "https://node.example-tail.ts.net:18443/probe"
	x.signIn(t)
	_, enrollment := x.request(t, "POST", "/api/enrollments", nil, true)
	token := enrollment["token"].(string)
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]string{"token": token, "name": "test-node", "public_key": base64.StdEncoding.EncodeToString(pub), "proof": base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte("workdeck-enroll:"+token)))}
	code, out := x.request(t, "POST", "/api/agent/enroll", payload, false)
	if code != http.StatusCreated {
		t.Fatal(code)
	}
	node := out["node_id"].(string)
	req, _ := http.NewRequest("GET", x.s.URL+"/api/agent/control", nil)
	req.Header.Set("X-Workdeck-Node", node)
	req.Header.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Workdeck-Nonce", randomID())
	req.Header.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(signaturePayload(req)))))
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+"/api/agent/control", req.Header)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var msg protocol.Message
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "hub.transport" || msg.TailnetHost != "node.example-tail.ts.net" {
		t.Fatalf("unexpected control configuration: %+v", msg)
	}
}
