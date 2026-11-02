package hub

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTailnetDiagnosticIsScopedBoundedAndRedacted(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	serverURL, _ := url.Parse(x.s.URL)
	cookies := x.client.Jar.Cookies(serverURL)
	if len(cookies) != 1 {
		t.Fatal("missing login cookie")
	}
	loginHash := digest(cookies[0].Value)
	node, terminal := randomID(), randomID()
	device := strings.Repeat("a", 64)
	marker := tailnetDiagnosticMarker{Device: device, Node: node, Expires: time.Now().Add(time.Minute).Unix()}
	body, _ := json.Marshal(marker)
	markerPath := filepath.Join(x.h.cfg.DataDir, ".tailnet-diagnostic")
	if err := os.WriteFile(markerPath, body, 0600); err != nil {
		t.Fatal(err)
	}
	x.h.mu.Lock()
	x.h.tailBindings[loginHash] = tailBinding{device: device, expires: time.Now().Add(time.Minute)}
	x.h.attachments["test"] = &attachment{loginHash: loginHash, nodeID: node, terminalID: terminal}
	x.h.mu.Unlock()
	if code, out := x.request(t, "GET", "/api/tailnet/diagnostic", nil, false); code != 200 || out["enabled"] != true || out["node_id"] != node {
		t.Fatalf("config: %d %v", code, out)
	}
	jar, _ := cookiejar.New(nil)
	other := &testHub{h: x.h, s: x.s, client: &http.Client{Jar: jar}, password: x.password}
	other.signIn(t)
	if code, out := other.request(t, "GET", "/api/tailnet/diagnostic", nil, false); code != 200 || out["enabled"] != false {
		t.Fatalf("other login got config: %d %v", code, out)
	}
	req := map[string]any{"terminal": terminal, "route": 1, "peer": 3, "local": 0, "remote": 2, "relay_rtt_ms": 19, "direct_rtt_ms": 8}
	if code, _ := other.request(t, "POST", "/api/tailnet/diagnostic", req, true); code != 403 {
		t.Fatalf("other login wrote diagnostic: %d", code)
	}
	if code, _ := x.request(t, "POST", "/api/tailnet/diagnostic", req, false); code != 403 {
		t.Fatalf("CSRF missing: %d", code)
	}
	// Use a raw request for the successful 204, which has no JSON response body.
	b, _ := json.Marshal(req)
	r, _ := http.NewRequest("POST", x.s.URL+"/api/tailnet/diagnostic", strings.NewReader(string(b)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", x.s.URL)
	r.Header.Set("X-Workdeck-CSRF", x.csrf)
	resp, err := x.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("write diagnostic: %d", resp.StatusCode)
	}
	data, err := os.ReadFile(filepath.Join(x.h.cfg.DataDir, "tailnet-diagnostic.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), terminal) || strings.Contains(string(data), node) || strings.Contains(string(data), device) {
		t.Fatal("diagnostic exposed identifier")
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil || len(result) != 9 || result["route"] != float64(1) || result["remote"] != float64(2) {
		t.Fatalf("unexpected numeric record: %v %v", result, err)
	}
	if err := os.Chmod(markerPath, 0644); err != nil {
		t.Fatal(err)
	}
	if code, out := x.request(t, "GET", "/api/tailnet/diagnostic", nil, false); code != 200 || out["enabled"] != false {
		t.Fatalf("insecure marker accepted: %d %v", code, out)
	}
}
