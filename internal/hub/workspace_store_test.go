package hub

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"workdeck/internal/files"
)

func TestWorkspacePersistenceAndChangeRecovery(t *testing.T) {
	x := setup(t)
	ctx := context.Background()
	_, err := x.h.store.db.Exec(`INSERT INTO nodes(id,name,public_key) VALUES('node','node','key')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = x.h.store.db.Exec(`INSERT INTO terminals(id,node_id,name,cwd,desired_state,observed_state,created_at,updated_at) VALUES('terminal','node','terminal','/project','running','running','now','now')`)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	records := make(chan workspaceRecord, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, e := x.h.store.reserveWorkspace(ctx, "terminal")
			if e != nil {
				t.Error(e)
				return
			}
			records <- w
		}()
	}
	wg.Wait()
	close(records)
	var w workspaceRecord
	for item := range records {
		if w.ID != "" && w.ID != item.ID {
			t.Fatal("initialization produced multiple workspaces")
		}
		w = item
	}
	if w.State != "initializing" || w.Root != "/project" {
		t.Fatal(w)
	}
	spec := files.Workspace{ID: w.ID, TerminalID: w.TerminalID, Root: "/project", Revision: 1, User: "account", Device: 3, Inode: 4}
	if err = x.h.store.confirmWorkspace(ctx, spec); err != nil {
		t.Fatal(err)
	}
	op := files.NewID(time.Now())
	if err = x.h.store.beginWorkspaceChange(ctx, w.ID, 1, op, "/other"); err != nil {
		t.Fatal(err)
	}
	if err = x.h.store.beginWorkspaceChange(ctx, w.ID, 1, files.NewID(time.Now()), "/other"); !errors.Is(err, errWorkspaceState) {
		t.Fatal(err)
	}
	// Open a second Store against the same database to simulate Hub restart.
	var seq int
	var name, dbPath string
	if err = x.h.store.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &dbPath); err != nil {
		t.Fatal(err)
	}
	second, err := OpenStore(filepath.Dir(dbPath), "admin", "")
	if err != nil {
		t.Fatal(err)
	}
	defer second.db.Close()
	recovered, err := second.workspaceByTerminal(ctx, "terminal")
	if err != nil || recovered.State != "changing" || recovered.PendingID != op || recovered.PendingTarget != "/other" {
		t.Fatal(recovered, err)
	}
	candidate := spec
	candidate.Root, candidate.Revision, candidate.Inode = "/canonical-other", 2, 5
	change := files.RootChange{ID: op, WorkspaceID: w.ID, OldRevision: 1, State: "prepared", Candidate: candidate}
	if err = second.recordWorkspaceCandidate(ctx, change); err != nil {
		t.Fatal(err)
	}
	if err = second.recordWorkspaceCandidate(ctx, change); err != nil {
		t.Fatal(err)
	}
	wrong := change
	wrong.Candidate.Inode++
	if err = second.recordWorkspaceCandidate(ctx, wrong); !errors.Is(err, errWorkspaceState) {
		t.Fatal(err)
	}
	wrong.State = "committed"
	if err = second.finishWorkspaceChange(ctx, wrong); !errors.Is(err, errWorkspaceState) {
		t.Fatal(err)
	}
	change.State = "committed"
	if err = second.finishWorkspaceChange(ctx, change); err != nil {
		t.Fatal(err)
	}
	recovered, err = second.workspaceByTerminal(ctx, "terminal")
	if err != nil || recovered.State != "ready" || recovered.Root != candidate.Root || recovered.Revision != 2 || recovered.Inode != 5 || recovered.PendingID != "" {
		t.Fatal(recovered, err)
	}
	if err = second.cancelWorkspaceChange(ctx, w.ID, 1, op); !errors.Is(err, errWorkspaceState) {
		t.Fatal(err)
	}
}
