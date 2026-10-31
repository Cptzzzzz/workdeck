package files

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestArchivedOperationSnapshotsNeverReplayOrChangeRoots(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	writeID, spec := f.stage(t, "created.txt", []byte("old content"), true)
	if _, err := f.e.Commit(ctx, f.w.ID, 1, writeID); err != nil {
		t.Fatal(err)
	}
	dirID := NewID(time.Now())
	if _, err := f.e.CreateDirectory(ctx, f.w.ID, 1, dirID, "made"); err != nil {
		t.Fatal(err)
	}
	meta := f.metadata(t, "created.txt")
	renameID := NewID(time.Now())
	if _, err := f.e.Rename(ctx, f.w.ID, 1, renameID, "created.txt", "renamed.txt", meta.Version); err != nil {
		t.Fatal(err)
	}
	meta = f.metadata(t, "renamed.txt")
	deleteID := NewID(time.Now())
	if _, err := f.e.PrepareDelete(ctx, f.w.ID, 1, deleteID, "renamed.txt", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.e.CommitDelete(ctx, f.w.ID, 1, deleteID); err != nil {
		t.Fatal(err)
	}
	next := filepath.Join(f.dir, "new-root")
	if err := os.Mkdir(next, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(next, "renamed.txt"), []byte("new root sentinel"), 0600); err != nil {
		t.Fatal(err)
	}
	changeID := NewID(time.Now())
	if _, err := f.e.PrepareRootChange(ctx, f.w.ID, 1, changeID, next); err != nil {
		t.Fatal(err)
	}
	if _, err := f.e.CommitRootChange(ctx, f.w.ID, changeID); err != nil {
		t.Fatal(err)
	}
	movedOldRoot := f.root + "-moved"
	if err := os.Rename(f.root, movedOldRoot); err != nil {
		t.Fatal(err)
	}
	write, err := f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, writeID)
	if err != nil || write.State != "committed" || write.Path != spec.Path || write.Write == nil || *write.Write != spec {
		t.Fatalf("write snapshot: %+v %v", write, err)
	}
	dir, err := f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, dirID)
	if err != nil || dir.State != "committed" || dir.Path != "made" || dir.Kind != "directory.create" {
		t.Fatalf("directory snapshot: %+v %v", dir, err)
	}
	rename, err := f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, renameID)
	if err != nil || rename.State != "committed" || rename.Path != "renamed.txt" || rename.Source != "created.txt" {
		t.Fatalf("rename snapshot: %+v %v", rename, err)
	}
	deleted, err := f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, deleteID)
	if err != nil || deleted.Delete == nil || deleted.Delete.Deleted != 1 || deleted.Path != "renamed.txt" {
		t.Fatalf("delete snapshot: %+v %v", deleted, err)
	}
	items, nextOffset, err := f.e.ArchivedDeleteOutcomes(ctx, f.w.ID, 2, 1, deleteID, 0, 64)
	if err != nil || len(items) != 1 || items[0].State != "deleted" || items[0].Path != "renamed.txt" || nextOffset != 1 {
		t.Fatalf("delete outcomes: %+v %d %v", items, nextOffset, err)
	}
	if _, err = f.e.db.Exec(`UPDATE mutations SET error_code='RESULT_EXPIRED',error_message='details expired' WHERE id=?`, deleteID); err != nil {
		t.Fatal(err)
	}
	expired, err := f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, deleteID)
	if err != nil || !expired.DetailsExpired || expired.Delete != nil {
		t.Fatalf("expired delete snapshot: %+v %v", expired, err)
	}
	_, _, err = f.e.ArchivedDeleteOutcomes(ctx, f.w.ID, 2, 1, deleteID, 0, 64)
	wantCode(t, err, "OPERATION_EXPIRED")
	_, err = f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 2, writeID)
	wantCode(t, err, "OPERATION_SCOPE")
	_, err = f.e.ArchivedOperationStatus(ctx, f.w.ID, 3, 1, writeID)
	wantCode(t, err, "STALE_WORKSPACE")
	_, err = f.e.ArchivedOperationStatus(ctx, NewID(time.Now()), 2, 1, writeID)
	if err == nil {
		t.Fatal("another workspace read an old operation")
	}
	other, err := f.e.RegisterWorkspace(ctx, Workspace{ID: NewID(time.Now()), TerminalID: NewID(time.Now()), Root: next, Revision: 2})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.ArchivedOperationStatus(ctx, other.ID, 2, 1, writeID)
	wantCode(t, err, "OPERATION_SCOPE")
	_, _, err = f.e.ArchivedDeleteOutcomes(ctx, other.ID, 2, 1, deleteID, 0, 64)
	wantCode(t, err, "OPERATION_SCOPE")
	_, err = f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, NewID(time.Now()))
	wantCode(t, err, "OPERATION_NOT_FOUND")
	// A stale uncertain/prepared journal must remain exactly as recorded: the
	// archived query is not allowed to reconcile against the replacement root.
	if _, err = f.e.db.Exec(`UPDATE operations SET state='uncertain' WHERE id=?`, writeID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.e.db.Exec(`UPDATE mutations SET state='prepared' WHERE id=?`, renameID); err != nil {
		t.Fatal(err)
	}
	write, err = f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, writeID)
	if err != nil || write.State != "uncertain" {
		t.Fatalf("uncertain journal changed: %+v %v", write, err)
	}
	rename, err = f.e.ArchivedOperationStatus(ctx, f.w.ID, 2, 1, renameID)
	if err != nil || rename.State != "prepared" {
		t.Fatalf("prepared journal changed: %+v %v", rename, err)
	}
	content, err := os.ReadFile(filepath.Join(next, "renamed.txt"))
	if err != nil || string(content) != "new root sentinel" {
		t.Fatalf("new root was modified: %q %v", content, err)
	}
	if _, err = os.Stat(filepath.Join(movedOldRoot, "renamed.txt")); !os.IsNotExist(err) {
		t.Fatal("old root was modified by archived query", err)
	}
}
