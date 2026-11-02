package hub

import (
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"
	"time"
	"workdeck/internal/tailprobe"
)

func TestTailnetProbeBindsLoginRejectsReplayAndExpires(t *testing.T) {
	x := setup(t)
	x.h.tailProbeSecret = []byte(strings.Repeat("s", 32))
	x.h.cfg.TailnetProbeURL = "https://node.example/probe"
	x.signIn(t)
	code, out := x.request(t, "POST", "/api/tailnet/probe", nil, true)
	if code != 200 || out["enabled"] != true {
		t.Fatalf("start: %d %v", code, out)
	}
	challenge := out["challenge"].(string)
	device := tailprobe.DeviceTag(x.h.tailProbeSecret, "private-node")
	body := map[string]string{"challenge": challenge, "device": device, "proof": tailprobe.Proof(x.h.tailProbeSecret, challenge, device)}
	jar, _ := cookiejar.New(nil)
	other := &testHub{h: x.h, s: x.s, client: &http.Client{Jar: jar}, password: x.password}
	other.signIn(t)
	if code, _ = other.request(t, "POST", "/api/tailnet/probe/complete", body, true); code != 403 {
		t.Fatalf("other login accepted: %d", code)
	}
	bad := map[string]string{"challenge": challenge, "device": device, "proof": strings.Repeat("0", 64)}
	if code, _ = x.request(t, "POST", "/api/tailnet/probe/complete", bad, true); code != 403 {
		t.Fatalf("forged proof accepted: %d", code)
	}
	if code, _ = x.request(t, "POST", "/api/tailnet/probe/complete", body, false); code != 403 {
		t.Fatalf("missing CSRF accepted: %d", code)
	}
	if code, _ = x.request(t, "POST", "/api/tailnet/probe/complete", body, true); code != 200 {
		t.Fatalf("valid proof rejected: %d", code)
	}
	if code, _ = x.request(t, "POST", "/api/tailnet/probe/complete", body, true); code != 403 {
		t.Fatalf("replay accepted: %d", code)
	}
	_, out = x.request(t, "POST", "/api/tailnet/probe", nil, true)
	expired := out["challenge"].(string)
	x.h.mu.Lock()
	c := x.h.tailChallenges[expired]
	c.expires = time.Now().Add(-time.Second)
	x.h.tailChallenges[expired] = c
	x.h.mu.Unlock()
	body["challenge"] = expired
	body["proof"] = tailprobe.Proof(x.h.tailProbeSecret, expired, device)
	if code, _ = x.request(t, "POST", "/api/tailnet/probe/complete", body, true); code != 403 {
		t.Fatalf("expired proof accepted: %d", code)
	}
	if code, _ = x.request(t, "POST", "/api/logout", nil, true); code != 200 {
		t.Fatal(code)
	}
	x.h.mu.Lock()
	defer x.h.mu.Unlock()
	if len(x.h.tailBindings) != 0 || len(x.h.tailChallenges) != 0 {
		t.Fatal("logout left Tailnet state")
	}
}

func TestTailnetProbeConfigRejectsUnsafeOrigins(t *testing.T) {
	secret := t.TempDir() + "/secret"
	if err := os.WriteFile(secret, []byte(strings.Repeat("s", 32)), 0600); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://example.com/probe", "https://user@example.com/probe", "https://example.com/other", "https://example.com/probe?token=secret", "https://example.com;script-src.example/probe"} {
		_, err := New(Config{PublicURL: "https://work.example.com", TailnetProbeURL: bad, TailnetProbeSecretFile: secret})
		if err == nil {
			t.Fatalf("accepted unsafe probe URL %q", bad)
		}
	}
}
