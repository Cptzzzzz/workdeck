package hub

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func randomID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func now() string            { return time.Now().UTC().Format(time.RFC3339) }
func OpenStore(dir, user, passwordFile string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "workdeck.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	schema := `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS accounts(username TEXT PRIMARY KEY,password_hash BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS logins(hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS enrollment_claims(hash TEXT PRIMARY KEY,node_id TEXT NOT NULL,public_key TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,public_key TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT NOT NULL DEFAULT '',hostname TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL DEFAULT '',home TEXT NOT NULL DEFAULT '',shell TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES nodes(id),name TEXT NOT NULL,cwd TEXT NOT NULL,desired_state TEXT NOT NULL,observed_state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',exit_code INTEGER);
 CREATE INDEX IF NOT EXISTS terminals_node ON terminals(node_id);`
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	var count int
	err = db.QueryRow("SELECT count(*) FROM accounts").Scan(&count)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		b, e := os.ReadFile(passwordFile)
		if e != nil {
			return nil, fmt.Errorf("initial administrator password: %w", e)
		}
		password := strings.TrimSpace(string(b))
		if len(password) < 16 {
			return nil, fmt.Errorf("initial password must contain at least 16 characters")
		}
		hash, e := bcrypt.GenerateFromPassword([]byte(password), 12)
		if e != nil {
			return nil, e
		}
		if _, e = db.Exec("INSERT INTO accounts(username,password_hash) VALUES(?,?)", user, hash); e != nil {
			return nil, e
		}
	}
	_ = os.Chmod(filepath.Join(dir, "workdeck.db"), 0600)
	return &Store{db}, nil
}

type Node struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	LastSeen string `json:"last_seen"`
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	Home     string `json:"home"`
	Shell    string `json:"shell"`
	Version  string `json:"version"`
	Online   bool   `json:"online"`
}
type Terminal struct {
	ID        string `json:"id"`
	NodeID    string `json:"node_id"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Desired   string `json:"desired_state"`
	State     string `json:"state"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Error     string `json:"error"`
	ExitCode  *int   `json:"exit_code"`
	Viewers   int    `json:"viewers"`
}

const terminalFields = "id,node_id,name,cwd,desired_state,observed_state,created_at,updated_at,error,exit_code"

func scanTerm(row interface{ Scan(...any) error }) (Terminal, error) {
	var t Terminal
	err := row.Scan(&t.ID, &t.NodeID, &t.Name, &t.Cwd, &t.Desired, &t.State, &t.CreatedAt, &t.UpdatedAt, &t.Error, &t.ExitCode)
	return t, err
}
func (s *Store) terminal(id string) (Terminal, error) {
	return scanTerm(s.db.QueryRow("SELECT "+terminalFields+" FROM terminals WHERE id=?", id))
}
