package hub

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNodeCodexProxyIsPrivateEncryptedAndRestored(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node := randomID()
	if _, e := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "test", "key"); e != nil {
		t.Fatal(e)
	}
	const proxy = "http://test-user:test-secret@proxy.example:7890"
	path := "/api/nodes/" + node + "/codex-settings"
	if code, _ := x.request(t, "PUT", path, map[string]string{"proxy": proxy}, false); code != 403 {
		t.Fatal("missing CSRF accepted", code)
	}
	if code, _ := x.request(t, "PUT", path, map[string]string{"proxy": proxy}, true); code != 200 {
		t.Fatal(code)
	}
	var sealed []byte
	if e := x.h.store.db.QueryRow("SELECT proxy FROM node_codex_settings WHERE node_id=?", node).Scan(&sealed); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(sealed, []byte("test-secret")) || bytes.Contains(sealed, []byte(proxy)) {
		t.Fatal("proxy stored as plaintext")
	}
	key, e := os.Stat(filepath.Join(x.h.cfg.DataDir, "node-proxy.key"))
	if e != nil || key.Mode().Perm() != 0600 {
		t.Fatal("proxy key permissions", e)
	}
	code, state := x.request(t, "GET", "/api/state", nil, false)
	if code != 200 {
		t.Fatal(code)
	}
	encoded, _ := json.Marshal(state)
	if bytes.Contains(encoded, []byte(proxy)) || bytes.Contains(encoded, []byte("test-secret")) {
		t.Fatal("credentials exposed in node inventory")
	}
	nodes := state["nodes"].([]any)
	if nodes[0].(map[string]any)["has_codex_proxy"] != true {
		t.Fatal("configured flag missing")
	}
	if code, value := x.request(t, "GET", path, nil, false); code != 200 || value["proxy"] != proxy {
		t.Fatal("proxy not returned to authenticated settings editor", code)
	}
	// Another node cannot authenticate this ciphertext even if its DB row is copied.
	other := randomID()
	_, _ = x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", other, "other", "key")
	_, _ = x.h.store.db.Exec("INSERT INTO node_codex_settings(node_id,proxy) VALUES(?,?)", other, sealed)
	if code, _ := x.request(t, "GET", "/api/nodes/"+other+"/codex-settings", nil, false); code != 500 {
		t.Fatal("ciphertext not bound to node", code)
	}
	_, _ = x.h.store.db.Exec("DELETE FROM node_codex_settings WHERE node_id=?", other)
	keyPath := filepath.Join(x.h.cfg.DataDir, "node-proxy.key")
	keyBytes, e := os.ReadFile(keyPath)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(keyPath); e != nil {
		t.Fatal(e)
	}
	if code, _ := x.request(t, "PUT", path, map[string]string{"proxy": "http://new.example:7890"}, true); code != 500 {
		t.Fatal("missing key silently regenerated", code)
	}
	if e = os.WriteFile(keyPath, keyBytes, 0600); e != nil {
		t.Fatal(e)
	}
	cfg := x.h.cfg
	x.s.Close()
	x.h.store.db.Close()
	restored, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(restored.Handler())
	restored.cfg.PublicURL = server.URL
	defer server.Close()
	defer restored.store.db.Close()
	x.h, x.s = restored, server
	if code, value := x.request(t, "GET", path, nil, false); code != 200 || value["proxy"] != proxy {
		t.Fatal("proxy not restored after restart", code)
	}
	if code, _ := x.request(t, "PUT", path, map[string]string{"proxy": ""}, true); code != 200 {
		t.Fatal(code)
	}
	if code, value := x.request(t, "GET", path, nil, false); code != 200 || value["proxy"] != "" {
		t.Fatal("could not clear proxy", code)
	}
}

func TestNodeCodexProxyValidationAndRevocation(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node := randomID()
	_, _ = x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "test", "key")
	path := "/api/nodes/" + node + "/codex-settings"
	if code, value := x.request(t, "PUT", path, map[string]string{"proxy": "file:///private-secret"}, true); code != 400 {
		t.Fatal("invalid proxy accepted", code, value)
	}
	if code, _ := x.request(t, "DELETE", "/api/nodes/"+node, nil, true); code != 200 {
		t.Fatal(code)
	}
	if code, _ := x.request(t, "PUT", path, map[string]string{"proxy": "http://proxy.example:7890"}, true); code != 404 {
		t.Fatal("revoked node settings editable", code)
	}
}
