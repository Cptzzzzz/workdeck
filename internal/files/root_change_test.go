package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRootChangeSurvivesRestartAndRejectsOldRevision(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	oldFile := filepath.Join(f.root, "old.txt")
	if err := os.WriteFile(oldFile, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	newDir := filepath.Join(f.dir, "new-root")
	if err := os.Mkdir(newDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newDir, "new.txt"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	prepared, err := f.e.PrepareRootChange(ctx, f.w.ID, 1, id, newDir)
	if err != nil || prepared.State != "prepared" || prepared.Candidate.Revision != 2 {
		t.Fatalf("prepare: %+v %v", prepared, err)
	}
	if _, err := f.e.Stat(ctx, f.w.ID, 1, "old.txt"); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.PrepareRootChange(ctx, f.w.ID, 1, id, f.root)
	wantCode(t, err, "ID_REUSED")
	_, err = f.e.PrepareRootChange(ctx, f.w.ID, 1, NewID(time.Now()), f.root)
	wantCode(t, err, "WORKSPACE_BUSY")
	if err := f.e.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := Open(filepath.Join(f.dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	status, err := next.RootChangeStatus(ctx, f.w.ID, id)
	if err != nil || status.State != "prepared" {
		t.Fatalf("recover prepare: %+v %v", status, err)
	}
	committed, err := next.CommitRootChange(ctx, f.w.ID, id)
	if err != nil || committed.State != "committed" {
		t.Fatalf("commit: %+v %v", committed, err)
	}
	again, err := next.CommitRootChange(ctx, f.w.ID, id)
	if err != nil || again.Candidate != committed.Candidate {
		t.Fatalf("retry: %+v %v", again, err)
	}
	_, err = next.Stat(ctx, f.w.ID, 1, "old.txt")
	wantCode(t, err, "STALE_WORKSPACE")
	if _, err := next.Stat(ctx, f.w.ID, 2, "new.txt"); err != nil {
		t.Fatal(err)
	}
	_, err = next.Stat(ctx, f.w.ID, 2, "old.txt")
	wantCode(t, err, "NOT_FOUND")
}

func TestRootChangeWaitIsCancelableAndProtectsPendingWrites(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(f.root, "old"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	newDir := filepath.Join(f.dir, "next")
	if err := os.Mkdir(newDir, 0700); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err := f.e.PrepareRootChange(ctx, f.w.ID, 1, id, newDir); err != nil {
		t.Fatal(err)
	}
	reader, err := f.e.OpenRead(ctx, f.w.ID, 1, "old", "")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	deadline, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	_, err = f.e.CommitRootChange(deadline, f.w.ID, id)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait should cancel: %v", err)
	}
	if _, err := f.e.Stat(ctx, f.w.ID, 1, "old"); err != nil {
		t.Fatalf("old root should remain usable: %v", err)
	}
	reader.Close()
	writeID, _ := f.stage(t, "pending", []byte("draft"), true)
	_, err = f.e.CommitRootChange(ctx, f.w.ID, id)
	wantCode(t, err, "WORKSPACE_BUSY")
	if _, err := f.e.Abort(ctx, f.w.ID, 1, writeID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.e.CommitRootChange(ctx, f.w.ID, id); err != nil {
		t.Fatal(err)
	}
}

func TestRootChangeRejectsReplacedCandidateAndConflictingIDs(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	newDir := filepath.Join(f.dir, "next")
	if err := os.Mkdir(newDir, 0700); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err := f.e.PrepareRootChange(ctx, f.w.ID, 1, id, newDir); err != nil {
		t.Fatal(err)
	}
	_, err := f.e.BeginWrite(ctx, f.w.ID, 1, id, WriteSpec{Path: "new", Create: true, SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"})
	wantCode(t, err, "ID_REUSED")
	if err := os.Rename(newDir, newDir+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(newDir, 0700); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.CommitRootChange(ctx, f.w.ID, id)
	wantCode(t, err, "ROOT_REPLACED")
	change, err := f.e.AbortRootChange(ctx, f.w.ID, id)
	if err != nil || change.State != "aborted" {
		t.Fatalf("abort: %+v %v", change, err)
	}
	_, err = f.e.CommitRootChange(ctx, f.w.ID, id)
	wantCode(t, err, "INVALID_STATE")
	writeID, _ := f.stage(t, "new-file", []byte("contents"), true)
	_, err = f.e.PrepareRootChange(ctx, f.w.ID, 1, writeID, newDir)
	wantCode(t, err, "ID_REUSED")
	if _, err := f.e.Abort(ctx, f.w.ID, 1, writeID); err != nil {
		t.Fatal(err)
	}
}
