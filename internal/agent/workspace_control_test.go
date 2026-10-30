package agent

import (
	"context"
	"os/user"
	"path/filepath"
	"testing"
	"time"

	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func TestWorkspaceControlUsesNodeSessionAndScopesChanges(t *testing.T) {
	account, err := serviceUser()
	if err != nil {
		t.Fatal(err)
	}
	a, terminal := testAgent(t, account.Username)
	root, next := t.TempDir(), t.TempDir()
	session := protocol.Session{ID: terminal, RunUser: account.Username, State: "running", Cwd: root}
	if err := atomicJSON(filepath.Join(a.sessions.dir, "sessions", terminal+".json"), session); err != nil {
		t.Fatal(err)
	}
	pool := newFileWorkerPool(a)
	pool.selfBinary = testWorkerBinary(t)
	pool.statePath = func(_ *user.User, _ string) string { return filepath.Join(t.TempDir(), "state") }
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	id, op := files.NewID(time.Now()), files.NewID(time.Now())
	msg := protocol.Message{Type: "workspace.register", TerminalID: terminal, WorkspaceID: id, Path: next}
	result := a.workspaceControl(ctx, pool, msg)
	if result.Error != "" || result.Workspace == nil || result.Workspace.Root != root || result.Workspace.User != account.Username {
		t.Fatalf("registration trusted remote input: %+v", result)
	}
	if again := a.workspaceControl(ctx, pool, msg); again.Error != "" || again.Workspace == nil || *again.Workspace != *result.Workspace {
		t.Fatalf("registration not idempotent: %+v", again)
	}
	// A second terminal in the same account cannot reuse the first terminal's workspace.
	other := files.NewID(time.Now())
	session.ID = other
	if err := atomicJSON(filepath.Join(a.sessions.dir, "sessions", other+".json"), session); err != nil {
		t.Fatal(err)
	}
	stolen := protocol.Message{Type: "workspace.prepare", TerminalID: other, WorkspaceID: id, OperationID: op, RootRevision: 1, Path: next}
	if denied := a.workspaceControl(ctx, pool, stolen); denied.ErrorCode != "OPERATION_SCOPE" {
		t.Fatalf("cross-terminal request accepted: %+v", denied)
	}
	msg = stolen
	msg.TerminalID = terminal
	prepared := a.workspaceControl(ctx, pool, msg)
	if prepared.Error != "" || prepared.RootChange == nil || prepared.RootChange.State != "prepared" {
		t.Fatalf("prepare: %+v", prepared)
	}
	msg.Type = "workspace.commit"
	committed := a.workspaceControl(ctx, pool, msg)
	if committed.Error != "" || committed.RootChange == nil || committed.RootChange.State != "committed" || committed.RootChange.Candidate.Root != next {
		t.Fatalf("commit: %+v", committed)
	}
	msg.Type = "workspace.status"
	status := a.workspaceControl(ctx, pool, msg)
	if status.Error != "" || status.RootChange == nil || status.RootChange.State != "committed" {
		t.Fatalf("status: %+v", status)
	}
}
