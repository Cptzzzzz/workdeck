package hub

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestPasswordChangePolicyAndLegacyCompatibility(t *testing.T) {
	x := setup(t)
	legacy, err := bcrypt.GenerateFromPassword([]byte(x.password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.h.store.db.Exec("UPDATE accounts SET password_hash=? WHERE username='admin'", legacy); err != nil {
		t.Fatal(err)
	}
	x.signIn(t) // Existing bcrypt accounts still authenticate after deployment.
	for _, password := range []string{"", "abc12", "abcdef", "ABCDEF", "123456", "中文中文中文"} {
		if code, _ := x.request(t, "POST", "/api/account/password", map[string]string{"current": x.password, "password": password}, true); code != 400 {
			t.Fatal("invalid password accepted", code)
		}
	}
	for _, password := range []string{"abc123", "ABC123", "Ab1!@#", "A1" + strings.Repeat("密", 100), "A1" + strings.Repeat("q", 3000)} {
		if code, out := x.request(t, "POST", "/api/account/password", map[string]string{"current": x.password, "password": password}, true); code != 200 {
			t.Fatal("password policy still rejects a supported value", code, out)
		}
		x.password = password
		x.signIn(t)
		if code, _ := x.request(t, "POST", "/api/login", map[string]string{"username": "admin", "password": password + "different-tail"}, false); code != 401 {
			t.Fatal("different password accepted", code)
		}
	}
	var stored []byte
	if err = x.h.store.db.QueryRow("SELECT password_hash FROM accounts WHERE username='admin'").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(stored, []byte(passwordPrefix)) {
		t.Fatal("updated password not saved in versioned hash format")
	}
}

func TestInitialPasswordsFollowPolicy(t *testing.T) {
	for _, password := range []string{"abc123", "ABC123", "A1" + strings.Repeat("长", 100), " leading and trailing spaces 1 "} {
		dir := t.TempDir()
		path := filepath.Join(dir, "initial-password")
		if err := os.WriteFile(path, []byte(password+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		store, err := OpenStore(dir, "admin", path)
		if err != nil {
			t.Fatal("initial password rejected", err)
		}
		var stored []byte
		err = store.db.QueryRow("SELECT password_hash FROM accounts WHERE username='admin'").Scan(&stored)
		store.db.Close()
		if err != nil || comparePassword(stored, password) != nil {
			t.Fatal("initial password was rejected or altered", err)
		}
	}
}

func TestNodeRenameValidationAndIdentity(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	id := randomID()
	if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", id, "original", "unchanged-key"); err != nil {
		t.Fatal(err)
	}
	if code, _ := x.request(t, "PATCH", "/api/nodes/"+id, map[string]string{"name": "  renamed node  "}, true); code != 200 {
		t.Fatal(code)
	}
	var name, key string
	if err := x.h.store.db.QueryRow("SELECT name,public_key FROM nodes WHERE id=?", id).Scan(&name, &key); err != nil || name != "renamed node" || key != "unchanged-key" {
		t.Fatal("rename changed node identity", err)
	}
	if code, _ := x.request(t, "PATCH", "/api/nodes/"+id, map[string]string{"name": " "}, true); code != 400 {
		t.Fatal("empty node name accepted")
	}
	if code, _ := x.request(t, "PATCH", "/api/nodes/"+randomID(), map[string]string{"name": "missing"}, true); code != 404 {
		t.Fatal("missing node renamed")
	}
}

func TestInitialPasswordRejectsMissingLettersDigitsOrLength(t *testing.T) {
	for _, password := range []string{"", "abc12", "abcdef", "123456"} {
		dir := t.TempDir()
		path := filepath.Join(dir, "initial-password")
		if err := os.WriteFile(path, []byte(password), 0600); err != nil {
			t.Fatal(err)
		}
		store, err := OpenStore(dir, "admin", path)
		if err == nil {
			store.db.Close()
			t.Fatal("invalid initial password accepted")
		}
	}
}
func TestNonCompliantExistingPasswordCanStillBeChanged(t *testing.T) {
	x := setup(t)
	old, err := hashPassword("x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.h.store.db.Exec("UPDATE accounts SET password_hash=? WHERE username='admin'", old); err != nil {
		t.Fatal(err)
	}
	x.password = "x"
	x.signIn(t)
	if code, _ := x.request(t, "POST", "/api/account/password", map[string]string{"current": "x", "password": "abc123"}, true); code != 200 {
		t.Fatal("existing password compatibility failed", code)
	}
}
