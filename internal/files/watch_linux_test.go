//go:build linux

package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDirectoryWatchDetectsChangesAndReplacedDirectories(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	w, err := f.e.NewDirectoryWatch(ctx, f.w.ID, 1, []string{".", "sub"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close() })
	quiet, err := w.Wait(ctx, 20*time.Millisecond)
	if err != nil || quiet.Changed || quiet.Reset || quiet.Generation != 1 {
		t.Fatalf("quiet: %+v %v", quiet, err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "sub", "file"), []byte("text"), 0600); err != nil {
		t.Fatal(err)
	}
	event, err := w.Wait(ctx, time.Second)
	if err != nil || !event.Changed || event.Reset {
		t.Fatalf("change: %+v %v", event, err)
	}
	if err := w.Set(ctx, []string{"sub"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.root, "sub"), filepath.Join(f.root, "old-sub")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(f.root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	event, err = w.Wait(ctx, time.Second)
	if err != nil || !event.Reset || event.Generation != 2 {
		t.Fatalf("replacement: %+v %v", event, err)
	}
	if err := w.Set(ctx, []string{"sub"}); err != nil {
		t.Fatal(err)
	}
	event, err = w.Wait(ctx, 20*time.Millisecond)
	if err != nil || event.Reset || event.Generation != 3 {
		t.Fatalf("rebound: %+v %v", event, err)
	}
}

func TestDirectoryWatchConfinesPathsAndCancels(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Symlink(f.dir, filepath.Join(f.root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(f.root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside", "/etc", "escape", "fifo"} {
		started := time.Now()
		w, err := f.e.NewDirectoryWatch(ctx, f.w.ID, 1, []string{path})
		if err == nil {
			w.Close()
			t.Fatalf("accepted %q", path)
		}
		if time.Since(started) > time.Second {
			t.Fatalf("blocked on %q", path)
		}
	}
	w, err := f.e.NewDirectoryWatch(ctx, f.w.ID, 1, []string{"."})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if err := w.Set(ctx, []string{".", "."}); ErrorCode(err) != "INVALID_WATCH" {
		t.Fatalf("duplicate paths: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := w.Wait(canceled, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	newRoot := filepath.Join(f.dir, "next")
	if err := os.Mkdir(newRoot, 0700); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err := f.e.PrepareRootChange(ctx, f.w.ID, 1, id, newRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := f.e.CommitRootChange(ctx, f.w.ID, id); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Wait(ctx, time.Second); ErrorCode(err) != "STALE_WORKSPACE" {
		t.Fatalf("stale revision: %v", err)
	}
}
