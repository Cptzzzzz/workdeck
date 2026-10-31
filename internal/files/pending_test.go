package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPendingWritesAreScopedAndCancellationRequiresCurrentState(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	otherRoot := filepath.Join(f.dir, "other")
	if err := os.Mkdir(otherRoot, 0700); err != nil {
		t.Fatal(err)
	}
	other, err := f.e.RegisterWorkspace(ctx, Workspace{ID: NewID(time.Now()), TerminalID: NewID(time.Now()), Root: otherRoot, Revision: 1})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("abcd"))
	spec := WriteSpec{Path: "target", Size: 4, Create: true, SHA256: hex.EncodeToString(sum[:])}
	id := NewID(time.Now())
	if _, err = f.e.BeginWrite(ctx, f.w.ID, 1, id, spec); err != nil {
		t.Fatal(err)
	}
	otherID := NewID(time.Now())
	if _, err = f.e.BeginWrite(ctx, other.ID, 1, otherID, spec); err != nil {
		t.Fatal(err)
	}
	page, err := f.e.PendingWrites(ctx, f.w.ID, 1, 0)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != id || page.HasMore {
		t.Fatalf("scope: %+v %v", page, err)
	}
	old := page.Items[0]
	if _, err = f.e.Append(ctx, f.w.ID, 1, id, 0, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.CancelPendingWrite(ctx, f.w.ID, 1, id, old.State, old.Offset, old.UpdatedAt)
	wantCode(t, err, "PRECONDITION_CHANGED")
	page, err = f.e.PendingWrites(ctx, f.w.ID, 1, 0)
	if err != nil || len(page.Items) != 1 || page.Items[0].State != "ready" {
		t.Fatalf("ready: %+v %v", page, err)
	}
	current := page.Items[0]
	_, err = f.e.CancelPendingWrite(ctx, other.ID, 1, id, current.State, current.Offset, current.UpdatedAt)
	wantCode(t, err, "OPERATION_SCOPE")
	_, err = f.e.PendingWrites(ctx, f.w.ID, 2, 0)
	wantCode(t, err, "STALE_WORKSPACE")
	op, err := f.e.CancelPendingWrite(ctx, f.w.ID, 1, id, current.State, current.Offset, current.UpdatedAt)
	if err != nil || op.State != "aborted" {
		t.Fatalf("cancel: %+v %v", op, err)
	}
	if _, err = os.Stat(filepath.Join(f.root, "target")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("target unexpectedly created", err)
	}
	if _, err = f.e.db.Exec(`UPDATE operations SET state='uncertain' WHERE id=?`, otherID); err != nil {
		t.Fatal(err)
	}
	page, err = f.e.PendingWrites(ctx, other.ID, 1, 0)
	if err != nil || len(page.Items) != 1 || page.Items[0].State != "uncertain" {
		t.Fatalf("uncertain: %+v %v", page, err)
	}
	_, err = f.e.CancelPendingWrite(ctx, other.ID, 1, otherID, "ready", page.Items[0].Offset, page.Items[0].UpdatedAt)
	wantCode(t, err, "PRECONDITION_CHANGED")
}

func TestPendingWritesUseBoundedPages(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	sum := sha256.Sum256([]byte("x"))
	for _, name := range []string{"first", "second"} {
		if _, err := f.e.BeginWrite(ctx, f.w.ID, 1, NewID(time.Now()), WriteSpec{Path: name, Size: 1, Create: true, SHA256: hex.EncodeToString(sum[:])}); err != nil {
			t.Fatal(err)
		}
	}
	a, err := f.e.PendingWrites(ctx, f.w.ID, 1, 0)
	if err != nil || len(a.Items) != 1 || !a.HasMore || a.Next != 1 {
		t.Fatalf("first page: %+v %v", a, err)
	}
	b, err := f.e.PendingWrites(ctx, f.w.ID, 1, a.Next)
	if err != nil || len(b.Items) != 1 || b.HasMore || b.Items[0].ID == a.Items[0].ID {
		t.Fatalf("second page: %+v %v", b, err)
	}
}

func TestPendingCancellationWithReplacedRootDoesNotTouchReplacement(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	sum := sha256.Sum256([]byte("x"))
	id := NewID(time.Now())
	if _, err := f.e.BeginWrite(ctx, f.w.ID, 1, id, WriteSpec{Path: "target", Size: 1, Create: true, SHA256: hex.EncodeToString(sum[:])}); err != nil {
		t.Fatal(err)
	}
	if err := f.e.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.root, f.root+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "target"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	next, err := Open(filepath.Join(f.dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = next.Close() })
	page, err := next.PendingWrites(ctx, f.w.ID, 1, 0)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list after root replacement: %+v %v", page, err)
	}
	item := page.Items[0]
	op, err := next.CancelPendingWrite(ctx, f.w.ID, 1, id, item.State, item.Offset, item.UpdatedAt)
	if err != nil || op.State != "aborted" {
		t.Fatalf("cancel after root replacement: %+v %v", op, err)
	}
	data, err := os.ReadFile(filepath.Join(f.root, "target"))
	if err != nil || string(data) != "replacement" {
		t.Fatalf("replacement changed: %q %v", data, err)
	}
}
