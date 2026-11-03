package tailprobe

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBridgeAuthenticatesActualTailnetPeerAndNeverReturnsNodeID(t *testing.T) {
	secret := []byte(strings.Repeat("s", 32))
	challenge := strings.Repeat("a", 48)
	calls := 0
	b := &Bridge{Origin: "https://work.example.com", Secret: secret, Lookup: func(_ context.Context, addr string) (string, error) {
		calls++
		if addr != "100.64.1.2:1234" {
			t.Fatalf("unexpected peer %q", addr)
		}
		return "private-node-id", nil
	}}
	request := func(peer, origin, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "https://node.example/probe", strings.NewReader(body))
		r.RemoteAddr = peer
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", "100.64.1.2")
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		return w
	}
	body := `{"challenge":"` + challenge + `"}`
	if w := request("203.0.113.3:1234", b.Origin, body); w.Code != http.StatusForbidden || calls != 0 {
		t.Fatalf("public peer accepted: %d", w.Code)
	}
	if w := request("100.64.1.2:1234", "https://evil.example", body); w.Code != http.StatusNotFound || calls != 0 {
		t.Fatalf("foreign origin accepted: %d", w.Code)
	}
	if w := request("100.64.1.2:1234", b.Origin, body+` {}`); w.Code != http.StatusBadRequest || calls != 0 {
		t.Fatalf("trailing data accepted: %d", w.Code)
	}
	w := request("100.64.1.2:1234", b.Origin, body)
	if w.Code != http.StatusOK || calls != 1 {
		t.Fatalf("valid probe: %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "private-node-id") {
		t.Fatal("raw node identity exposed")
	}
	var result struct {
		Device string `json:"device"`
		Proof  string `json:"proof"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || !Verify(secret, challenge, result.Device, result.Proof) {
		t.Fatalf("invalid signed proof: %v", err)
	}
	if Verify(secret, strings.Repeat("b", 48), result.Device, result.Proof) {
		t.Fatal("proof not bound to challenge")
	}
	if w.Header().Get("Access-Control-Allow-Origin") != b.Origin {
		t.Fatal("missing constrained CORS")
	}
	b.LegacyOrigin = "https://old.example.com"
	w = request("100.64.1.2:1234", b.LegacyOrigin, body)
	if w.Code != http.StatusOK || w.Header().Get("Access-Control-Allow-Origin") != b.LegacyOrigin {
		t.Fatal("configured legacy origin was not accepted", w.Code)
	}
	if w := request("100.64.1.2:1234", "https://other.example.com", body); w.Code != http.StatusNotFound {
		t.Fatal("unconfigured origin accepted", w.Code)
	}
}
