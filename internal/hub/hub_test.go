package hub

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type testHub struct {
	h        *Hub
	s        *httptest.Server
	client   *http.Client
	csrf     string
	password string
}

func setup(t *testing.T) *testHub {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "password")
	password := "a-long-test-password-123456"
	if err := os.WriteFile(p, []byte(password), 0600); err != nil {
		t.Fatal(err)
	}
	h, err := New(Config{PublicURL: "http://127.0.0.1:8090", DataDir: dir, AdminUser: "admin", PasswordFile: p, AssetsDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(h.Handler())
	h.cfg.PublicURL = s.URL
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	x := &testHub{h: h, s: s, client: client, password: password}
	t.Cleanup(func() { s.Close(); h.store.db.Close() })
	return x
}
func (x *testHub) request(t *testing.T, method, path string, body any, csrf bool) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, x.s.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", x.s.URL)
	if csrf {
		req.Header.Set("X-Workdeck-CSRF", x.csrf)
	}
	res, err := x.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, out
}
func (x *testHub) signIn(t *testing.T) {
	t.Helper()
	code, out := x.request(t, "POST", "/api/login", map[string]string{"username": "admin", "password": x.password}, false)
	if code != 200 {
		t.Fatalf("login: %d %v", code, out)
	}
	x.csrf = out["csrf"].(string)
}
func TestAuthenticationAndCSRF(t *testing.T) {
	x := setup(t)
	if code, _ := x.request(t, "GET", "/api/state", nil, false); code != 401 {
		t.Fatal(code)
	}
	if code, _ := x.request(t, "POST", "/api/login", map[string]string{"username": "admin", "password": "wrong"}, false); code != 401 {
		t.Fatal(code)
	}
	x.signIn(t)
	if code, _ := x.request(t, "POST", "/api/enrollments", nil, false); code != 403 {
		t.Fatal("missing CSRF accepted", code)
	}
	req, _ := http.NewRequest("POST", x.s.URL+"/api/enrollments", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://attacker.example")
	req.Header.Set("X-Workdeck-CSRF", x.csrf)
	res, err := x.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("cross-origin accepted")
	}
	if code, _ := x.request(t, "POST", "/api/logout", nil, true); code != 200 {
		t.Fatal(code)
	}
	if code, _ := x.request(t, "GET", "/api/state", nil, false); code != 401 {
		t.Fatal("logout did not revoke session")
	}
}
func TestEnrollmentAndReplayProtection(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	_, out := x.request(t, "POST", "/api/enrollments", nil, true)
	token := out["token"].(string)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	payload := map[string]string{"token": token, "name": "test-node", "public_key": base64.StdEncoding.EncodeToString(pub), "proof": base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte("workdeck-enroll:"+token)))}
	code, out := x.request(t, "POST", "/api/agent/enroll", payload, false)
	if code != 201 {
		t.Fatal(code, out)
	}
	node := out["node_id"].(string)
	if code, retry := x.request(t, "POST", "/api/agent/enroll", payload, false); code != 201 || retry["node_id"] != node {
		t.Fatal("lost enrollment response could not be recovered", code)
	}
	pub2, key2, _ := ed25519.GenerateKey(rand.Reader)
	payload["public_key"] = base64.StdEncoding.EncodeToString(pub2)
	payload["proof"] = base64.StdEncoding.EncodeToString(ed25519.Sign(key2, []byte("workdeck-enroll:"+token)))
	if code, _ = x.request(t, "POST", "/api/agent/enroll", payload, false); code != 403 {
		t.Fatal("one-time token enrolled another key", code)
	}

	// Use identical signed request twice; the second handshake must be rejected.
	req, _ := http.NewRequest("GET", x.s.URL+"/api/agent/control", nil)
	req.Header.Set("X-Workdeck-Node", node)
	req.Header.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Workdeck-Nonce", randomID())
	req.Header.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(signaturePayload(req)))))
	dialer := websocket.Dialer{}
	conn, res, err := dialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+"/api/agent/control", req.Header)
	if err != nil {
		t.Fatal(err, res)
	}
	conn.Close()
	conn, res, err = dialer.Dial("ws"+strings.TrimPrefix(x.s.URL, "http")+"/api/agent/control", req.Header)
	if err == nil {
		conn.Close()
		t.Fatal("replayed signed handshake accepted")
	}
	if res == nil || res.StatusCode != 401 {
		t.Fatal("wrong replay response", res)
	}
	if res != nil {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
}
func TestPasswordChangeRevokesOtherSessions(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	jar, _ := cookiejar.New(nil)
	other := &testHub{h: x.h, s: x.s, client: &http.Client{Jar: jar}, password: x.password}
	other.signIn(t)
	if code, _ := x.request(t, "POST", "/api/account/password", map[string]string{"current": x.password, "password": "another-strong-password-123456"}, true); code != 200 {
		t.Fatal(code)
	}
	if code, _ := other.request(t, "GET", "/api/me", nil, false); code != 401 {
		t.Fatal("other login not revoked")
	}
	if code, _ := x.request(t, "GET", "/api/me", nil, false); code != 200 {
		t.Fatal("current login should remain valid")
	}
}
