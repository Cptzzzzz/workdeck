package hub

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestLoginRateCountsFailuresRatherThanSuccessfulDevices(t *testing.T) {
	x := setup(t)
	// Use a fast legacy hash so the test exercises rate accounting rather than
	// password-hashing cost; the production hash policy remains unchanged.
	hash, err := bcrypt.GenerateFromPassword([]byte(x.password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.h.store.db.Exec("UPDATE accounts SET password_hash=? WHERE username='admin'", hash); err != nil {
		t.Fatal(err)
	}
	login := func(password string) int {
		code, _ := x.request(t, "POST", "/api/login", map[string]string{"username": "admin", "password": password}, false)
		return code
	}
	for i := 0; i < 35; i++ {
		if code := login(x.password); code != 200 {
			t.Fatalf("valid login %d: %d", i, code)
		}
	}
	for i := 0; i < 29; i++ {
		if code := login("wrong"); code != 401 {
			t.Fatalf("invalid login %d: %d", i, code)
		}
	}
	if code := login(x.password); code != 200 {
		t.Fatalf("successful reset: %d", code)
	}
	for i := 0; i < 30; i++ {
		if code := login("wrong"); code != 401 {
			t.Fatalf("failure after reset %d: %d", i, code)
		}
	}
	if code := login(x.password); code != 429 {
		t.Fatalf("failure limit: %d", code)
	}
}
