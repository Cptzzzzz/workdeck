package hub

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workdeck/internal/protocol"
)

func TestPersistentDeviceSessionsAndHubRestart(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	jar, _ := cookiejar.New(nil)
	other := &testHub{h: x.h, s: x.s, client: &http.Client{Jar: jar}, password: x.password}
	other.signIn(t)
	if code, _ := x.request(t, "GET", "/api/me", nil, false); code != 200 {
		t.Fatal("second device invalidated first login")
	}
	node, terminal := randomID(), randomID()
	if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key,boot_id,capabilities) VALUES(?,?,?,?,?)", node, "compute-on-hub", "public-key", "old-boot", `["directories"]`); err != nil {
		t.Fatal(err)
	}
	if _, err := x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", terminal, node, "remembered terminal", "/tmp", "running", "running", now(), now(), ""); err != nil {
		t.Fatal(err)
	}
	// Exercise the actual disk database and cookie through a fresh Hub instance.
	cfg := x.h.cfg
	cfg.PasswordFile = "/does/not/exist"
	x.s.Close()
	if err := x.h.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(restored.Handler())
	restored.cfg.PublicURL = server.URL
	t.Cleanup(func() { server.Close(); restored.store.db.Close() })
	x.h, x.s = restored, server
	other.h, other.s = restored, server
	if code, _ := x.request(t, "GET", "/api/me", nil, false); code != 200 {
		t.Fatal("login lost after Hub restart")
	}
	if code, _ := other.request(t, "GET", "/api/me", nil, false); code != 200 {
		t.Fatal("other device login lost after Hub restart")
	}
	code, state := x.request(t, "GET", "/api/state", nil, false)
	if code != 200 || len(state["nodes"].([]any)) != 1 || len(state["terminals"].([]any)) != 1 {
		t.Fatal(code, state)
	}
	n := state["nodes"].([]any)[0].(map[string]any)
	if n["online"] != false {
		t.Fatal("node must remain offline until it reconnects")
	}
	restored.applyInventory(node, protocol.Message{Type: "inventory", Complete: true, BootID: "new-boot", Capabilities: []string{"directories", "full-inventory"}})
	record, err := restored.store.terminal(terminal)
	if err != nil || record.ID != terminal || record.State != "lost" || !strings.Contains(record.Error, "重启") {
		t.Fatal("state not reconciled after node boot", record, err)
	}
	if code, _ = x.request(t, "POST", "/api/logout", nil, true); code != 200 {
		t.Fatal(code)
	}
	if code, _ = other.request(t, "GET", "/api/me", nil, false); code != 200 {
		t.Fatal("logout on one device logged out another")
	}
}

func TestLoginCookieIsPersistentAndRenews(t *testing.T) {
	x := setup(t)
	request := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"username":"admin","password":"`+x.password+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	x.h.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing login cookie")
	}
	cookie := cookies[0]
	if cookie.Expires.Before(time.Now().Add(29*24*time.Hour)) || cookie.MaxAge < 29*86400 || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("not a persistent protected cookie", cookie)
	}
	_, err := x.h.store.db.Exec("UPDATE logins SET expires=? WHERE hash=?", time.Now().Add(2*24*time.Hour).Unix(), digest(cookie.Value))
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest("GET", "/api/me", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	x.h.Handler().ServeHTTP(response, request)
	renewed := response.Result().Cookies()
	if response.Code != 200 || len(renewed) != 1 || renewed[0].Value != cookie.Value || renewed[0].Expires.Before(time.Now().Add(29*24*time.Hour)) {
		t.Fatal("active device session did not renew")
	}
	var expiry int64
	if err = x.h.store.db.QueryRow("SELECT expires FROM logins WHERE hash=?", digest(cookie.Value)).Scan(&expiry); err != nil || expiry < time.Now().Add(29*24*time.Hour).Unix() {
		t.Fatal("renewal not saved to disk", err)
	}
}

func TestOnlyCompleteInventoriesMarkUnreportedSessionsLost(t *testing.T) {
	x := setup(t)
	node, first, missing := randomID(), randomID(), randomID()
	if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "node", "key"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first, missing} {
		if _, err := x.h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", id, node, id, "/tmp", "running", "running", now(), now(), ""); err != nil {
			t.Fatal(err)
		}
	}
	message := protocol.Message{Type: "inventory", Sessions: []protocol.Session{{ID: first, State: "running"}}, Complete: false}
	x.h.applyInventory(node, message)
	if record, _ := x.h.store.terminal(missing); record.State != "running" {
		t.Fatal("incomplete snapshot changed missing session", record)
	}
	message.Complete = true
	x.h.applyInventory(node, message)
	if record, _ := x.h.store.terminal(missing); record.State != "lost" {
		t.Fatal("complete snapshot did not reconcile missing session", record)
	}
	if record, _ := x.h.store.terminal(first); record.State != "running" {
		t.Fatal("known surviving session changed", record)
	}
}
