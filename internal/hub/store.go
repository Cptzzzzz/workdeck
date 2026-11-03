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

	"workdeck/internal/protocol"

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
 CREATE INDEX IF NOT EXISTS terminals_node ON terminals(node_id);
 CREATE TABLE IF NOT EXISTS terminal_tasks(terminal_id TEXT PRIMARY KEY REFERENCES terminals(id), note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', important INTEGER NOT NULL DEFAULT 0, manual_status TEXT NOT NULL DEFAULT '', codex_turn TEXT NOT NULL DEFAULT '', codex_completed_at TEXT NOT NULL DEFAULT '', codex_command TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,terminal_id TEXT NOT NULL UNIQUE REFERENCES terminals(id),node_id TEXT NOT NULL REFERENCES nodes(id),root_path TEXT NOT NULL,root_revision INTEGER NOT NULL,run_user TEXT NOT NULL DEFAULT '',device TEXT NOT NULL DEFAULT '',inode TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('initializing','ready','changing')),pending_id TEXT NOT NULL DEFAULT '',pending_target TEXT NOT NULL DEFAULT '',pending_candidate TEXT NOT NULL DEFAULT '');`
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	for name, definition := range map[string]string{"codex_details": "TEXT NOT NULL DEFAULT '{}'", "codex_status": "TEXT NOT NULL DEFAULT ''", "codex_event": "TEXT NOT NULL DEFAULT ''", "codex_observed_at": "TEXT NOT NULL DEFAULT ''", "codex_detected": "INTEGER"} {
		rows, e := db.Query("PRAGMA table_info(terminal_tasks)")
		if e != nil {
			db.Close()
			return nil, e
		}
		found := false
		for rows.Next() {
			var cid, notnull, pk int
			var col, typ string
			var value any
			if e = rows.Scan(&cid, &col, &typ, &notnull, &value, &pk); e != nil {
				rows.Close()
				db.Close()
				return nil, e
			}
			if col == name {
				found = true
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			db.Close()
			return nil, e
		}
		if !found {
			if _, e = db.Exec("ALTER TABLE terminal_tasks ADD COLUMN " + name + " " + definition); e != nil {
				db.Close()
				return nil, e
			}
		}
	}
	// Additive migrations preserve existing node identities, sessions, and logins.
	for name, definition := range map[string]string{"capabilities": "TEXT NOT NULL DEFAULT '[]'", "boot_id": "TEXT NOT NULL DEFAULT ''", "run_user": "TEXT NOT NULL DEFAULT ''", "hardware": "TEXT NOT NULL DEFAULT ''"} {
		rows, e := db.Query("PRAGMA table_info(nodes)")
		if e != nil {
			db.Close()
			return nil, e
		}
		found := false
		for rows.Next() {
			var cid, notnull, pk int
			var col, typ string
			var value any
			if e = rows.Scan(&cid, &col, &typ, &notnull, &value, &pk); e != nil {
				rows.Close()
				db.Close()
				return nil, e
			}
			if col == name {
				found = true
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			db.Close()
			return nil, e
		}
		if !found {
			if _, e = db.Exec("ALTER TABLE nodes ADD COLUMN " + name + " " + definition); e != nil {
				db.Close()
				return nil, e
			}
		}
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
		password := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
		if err := validatePassword(password); err != nil {
			db.Close()
			return nil, err
		}
		hash, e := hashPassword(password)
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
	Hardware     *protocol.NodeHardware `json:"hardware,omitempty"`
	RunUser      string                 `json:"run_user"`
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	LastSeen     string                 `json:"last_seen"`
	Hostname     string                 `json:"hostname"`
	Platform     string                 `json:"platform"`
	Home         string                 `json:"home"`
	Shell        string                 `json:"shell"`
	Version      string                 `json:"version"`
	Online       bool                   `json:"online"`
	Capabilities []string               `json:"capabilities"`
}
type Terminal struct {
	ID        string    `json:"id"`
	NodeID    string    `json:"node_id"`
	Name      string    `json:"name"`
	Cwd       string    `json:"cwd"`
	Desired   string    `json:"desired_state"`
	State     string    `json:"state"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	Error     string    `json:"error"`
	ExitCode  *int      `json:"exit_code"`
	Viewers   int       `json:"viewers"`
	Task      *TaskInfo `json:"task,omitempty"`
}

type TaskInfo struct {
	Note             string                     `json:"note"`
	Tags             string                     `json:"tags"`
	Important        bool                       `json:"important"`
	ManualStatus     string                     `json:"manual_status"`
	CodexTurn        string                     `json:"codex_turn"`
	CodexCompletedAt string                     `json:"codex_completed_at"`
	CodexCommand     string                     `json:"codex_command"`
	CodexStatus      string                     `json:"codex_status"`
	CodexEvent       string                     `json:"codex_event"`
	CodexObservedAt  string                     `json:"codex_observed_at"`
	Codex            *protocol.CodexObservation `json:"codex,omitempty"`
	CodexDetected    *bool                      `json:"codex_detected"`
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
