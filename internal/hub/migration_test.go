package hub

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func migrationRequest(t *testing.T, x *testHub, path, origin string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", x.s.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	res, err := x.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&data)
	return res.StatusCode, data
}

func TestMigrationSingleUseAndOrigin(t *testing.T) {
	x := setup(t)
	x.h.cfg.LegacyOrigin = "https://old.example"
	x.s.Close()
	x.s = httptest.NewServer(x.h.Handler())
	t.Cleanup(x.s.Close)
	x.h.cfg.PublicURL = x.s.URL
	x.signIn(t)
	code, _ := migrationRequest(t, x, "/api/migration/issue", "https://attacker.example", map[string]any{})
	if code != 403 {
		t.Fatal("issue accepted attacker", code)
	}
	code, out := migrationRequest(t, x, "/api/migration/issue", x.h.cfg.LegacyOrigin, map[string]any{})
	if code != 200 {
		t.Fatal(code, out)
	}
	ticket := out["ticket"].(string)
	code, _ = migrationRequest(t, x, "/api/migration/redeem", "https://attacker.example", map[string]string{"ticket": ticket})
	if code != 403 {
		t.Fatal("redeem accepted attacker", code)
	}
	code, out = migrationRequest(t, x, "/api/migration/redeem", x.h.cfg.PublicURL, map[string]string{"ticket": ticket})
	if code != 200 || out["username"] != "admin" {
		t.Fatal(code, out)
	}
	code, _ = migrationRequest(t, x, "/api/migration/redeem", x.h.cfg.PublicURL, map[string]string{"ticket": ticket})
	if code != 401 {
		t.Fatal("ticket replay accepted", code)
	}
}

func TestMigrationRevokedLoginAndFramePolicy(t *testing.T) {
	x := setup(t)
	x.h.cfg.LegacyOrigin = "https://old.example"
	x.s.Close()
	x.s = httptest.NewServer(x.h.Handler())
	t.Cleanup(x.s.Close)
	x.h.cfg.PublicURL = x.s.URL
	x.signIn(t)
	code, out := migrationRequest(t, x, "/api/migration/issue", x.h.cfg.LegacyOrigin, map[string]any{})
	if code != 200 {
		t.Fatal(code)
	}
	ticket := out["ticket"].(string)
	if code, _ = x.request(t, "POST", "/api/logout", map[string]any{}, true); code != 200 {
		t.Fatal(code)
	}
	code, _ = migrationRequest(t, x, "/api/migration/redeem", x.h.cfg.PublicURL, map[string]string{"ticket": ticket})
	if code != 401 {
		t.Fatal("revoked login migrated", code)
	}
	req := httptest.NewRequest("GET", "https://old.example/migration/frame", nil)
	rec := httptest.NewRecorder()
	x.h.Handler().ServeHTTP(rec, req)
	res := rec.Result()
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode != 200 || res.Header.Get("X-Frame-Options") != "" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "frame-ancestors "+x.h.cfg.PublicURL) {
		t.Fatal("bad frame policy", res.StatusCode, res.Header)
	}
	req = httptest.NewRequest("GET", "https://wrong.example/migration/frame", nil)
	rec = httptest.NewRecorder()
	x.h.Handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatal("frame exposed on other host", rec.Code)
	}
}
