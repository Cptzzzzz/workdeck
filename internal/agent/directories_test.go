package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workdeck/internal/protocol"
)

func TestDirectoryBrowsing(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"alpha", "beta/nested", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "beta"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	listing, err := ListDirectories(context.Background(), root, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 3 || listing.Entries[0].Name != "alpha" || listing.Parent != filepath.Dir(root) {
		t.Fatalf("wrong child directories: %+v", listing)
	}
	child, err := ListDirectories(context.Background(), listing.Entries[2].Path, false)
	if err != nil {
		t.Fatal(err)
	}
	if child.Path != filepath.Join(root, "beta") || child.Entries[0].Name != "nested" {
		t.Fatalf("symlink navigation: %+v", child)
	}
	listing, err = ListDirectories(context.Background(), root, true)
	if err != nil || len(listing.Entries) != 4 {
		t.Fatal(listing, err)
	}
	if _, err = ListDirectories(context.Background(), "relative/path", false); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, err = ListDirectories(context.Background(), filepath.Join(root, "file.txt"), false); err == nil {
		t.Fatal("file accepted as directory")
	}
	if _, err = ListDirectories(context.Background(), filepath.Join(root, "missing"), false); err == nil {
		t.Fatal("missing directory accepted")
	}
}

func TestInventoryPreservesRecordsAfterNodeRestart(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	// No tmux process is launched in this test: the executable simulates an absent old session.
	manager := &Sessions{dir: dir, tmux: "/bin/false", bootID: "new-boot"}
	id := strings.Repeat("a", 48)
	original := protocol.Session{ID: id, Name: "persistent metadata", Cwd: dir, State: "running", BootID: "old-boot"}
	if err := atomicJSON(manager.path(id), original); err != nil {
		t.Fatal(err)
	}
	sessions, err := manager.Inventory()
	if err != nil || len(sessions) != 1 {
		t.Fatal(sessions, err)
	}
	if sessions[0].State != "lost" || !strings.Contains(sessions[0].Error, "重启") {
		t.Fatal(sessions[0])
	}
	reloaded, err := manager.read(id)
	if err != nil || reloaded.Name != original.Name || reloaded.Cwd != dir || reloaded.State != "lost" {
		t.Fatal(reloaded, err)
	}
	if err = os.WriteFile(filepath.Join(dir, "sessions", strings.Repeat("b", 48)+".json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	sessions, err = manager.Inventory()
	if err == nil || len(sessions) != 1 {
		t.Fatal("corrupt record must make snapshot incomplete", sessions, err)
	}
}
