package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestUploadQuotaDoesNotChangeFiles(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	sum := sha256.Sum256([]byte("x"))
	var ids []string
	for i := 0; i < 16; i++ {
		id := NewID(time.Now())
		spec := WriteSpec{Path: fmt.Sprintf("pending-%d", i), Size: 1, Create: true, SHA256: hex.EncodeToString(sum[:])}
		if _, err := f.e.BeginWrite(ctx, f.w.ID, 1, id, spec); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	blockedID := NewID(time.Now())
	spec := WriteSpec{Path: "blocked", Size: 1, Create: true, SHA256: hex.EncodeToString(sum[:])}
	_, err := f.e.BeginWrite(ctx, f.w.ID, 1, blockedID, spec)
	wantCode(t, err, "QUOTA_EXCEEDED")
	if _, err = os.Lstat(filepath.Join(f.root, "blocked")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("quota failure created target: %v", err)
	}
	if _, err = f.e.Abort(ctx, f.w.ID, 1, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = f.e.BeginWrite(ctx, f.w.ID, 1, blockedID, spec); err != nil {
		t.Fatalf("reservation not released: %v", err)
	}
}

func TestPermissionRevokedDuringSavePreservesOriginal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires an unprivileged account")
	}
	f := setupFiles(t)
	ctx := context.Background()
	original := []byte("original content")
	if err := os.WriteFile(filepath.Join(f.root, "document"), original, 0600); err != nil {
		t.Fatal(err)
	}
	id, _ := f.stage(t, "document", []byte("new content"), false)
	if err := os.Chmod(f.root, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(f.root, 0700) })
	op, err := f.e.Commit(ctx, f.w.ID, 1, id)
	if err != nil || op.State != "uncertain" {
		t.Fatalf("unexpected state: %+v %v", op, err)
	}
	if !bytes.Equal(f.read(t, "document"), original) {
		t.Fatal("permission failure changed original")
	}
	if err = os.Chmod(f.root, 0700); err != nil {
		t.Fatal(err)
	}
	op, err = f.e.Status(ctx, f.w.ID, 1, id)
	if err != nil || op.State != "uncertain" {
		t.Fatalf("unexpected state: %+v %v", op, err)
	}
	op, err = f.e.Commit(ctx, f.w.ID, 1, id)
	if err != nil || op.State != "uncertain" {
		t.Fatalf("retry state: %+v %v", op, err)
	}
	if !bytes.Equal(f.read(t, "document"), original) {
		t.Fatal("uncertain retry overwrote original")
	}
}

// Requires a dedicated, small tmpfs mounted by the test runner. Never fill an
// arbitrary host filesystem even if the environment variable is misconfigured.
func TestDiskFullPreservesOriginalAndAllowsRetry(t *testing.T) {
	root := os.Getenv("WORKDECK_DISK_FULL_ROOT")
	if root == "" {
		t.Skip("requires a dedicated small tmpfs")
	}
	var fs unix.Statfs_t
	if err := unix.Statfs(root, &fs); err != nil || fs.Type != unix.TMPFS_MAGIC || uint64(fs.Blocks)*uint64(fs.Bsize) > 32<<20 {
		t.Fatal("test root must be a dedicated tmpfs of at most 32 MiB")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("test root must be a real directory")
	}
	parent, err := os.Stat(filepath.Dir(filepath.Clean(root)))
	if err != nil || identity(info).Device == identity(parent).Device {
		t.Fatal("test root must be a separate mount")
	}
	contents, err := os.ReadDir(root)
	if err != nil || len(contents) != 0 {
		t.Fatal("test root must initially be empty")
	}
	base, err := os.MkdirTemp(root, "workdeck-full-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	project := filepath.Join(base, "project")
	if err = os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	e, err := Open(filepath.Join(base, "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	w, err := e.RegisterWorkspace(context.Background(), Workspace{ID: NewID(time.Now()), TerminalID: NewID(time.Now()), Root: project, Revision: 1})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{e: e, dir: base, root: project, w: w}
	original := bytes.Repeat([]byte("original"), 256*1024)
	if err = os.WriteFile(filepath.Join(project, "document"), original, 0600); err != nil {
		t.Fatal(err)
	}
	replacement := []byte("replacement after capacity recovery")
	id, _ := f.stage(t, "document", replacement, false)
	fillerPath := filepath.Join(base, "filler")
	filler, err := os.OpenFile(fillerPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	block := make([]byte, 64*1024)
	for written := 0; ; written += len(block) {
		if written > 32<<20 {
			t.Fatal("tmpfs unexpectedly exceeded bound")
		}
		_, err = filler.Write(block)
		if err != nil {
			break
		}
	}
	if !errors.Is(err, syscall.ENOSPC) {
		t.Fatalf("expected full tmpfs: %v", err)
	}
	if err = filler.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = e.Commit(context.Background(), w.ID, 1, id)
	if !errors.Is(err, syscall.ENOSPC) {
		t.Fatalf("expected commit capacity error: %v", err)
	}
	if !bytes.Equal(f.read(t, "document"), original) {
		t.Fatal("disk-full commit changed original")
	}
	if err = os.Remove(fillerPath); err != nil {
		t.Fatal(err)
	}
	op, err := e.Status(context.Background(), w.ID, 1, id)
	if err != nil || op.State != "ready" {
		t.Fatalf("pending state after disk full: %+v %v", op, err)
	}
	op, err = e.Commit(context.Background(), w.ID, 1, id)
	if err != nil || op.State != "committed" || !bytes.Equal(f.read(t, "document"), replacement) {
		t.Fatalf("retry failed: %+v %v", op, err)
	}
}
