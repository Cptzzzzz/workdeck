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
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type fixture struct {
	e         *Engine
	dir, root string
	w         Workspace
}

func setupFiles(t *testing.T) *fixture {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "project")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	e, err := Open(filepath.Join(base, "state"))
	if err != nil {
		t.Fatal(err)
	}
	w, err := e.RegisterWorkspace(context.Background(), Workspace{ID: NewID(time.Now()), TerminalID: NewID(time.Now()), Root: root, Revision: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return &fixture{e: e, dir: base, root: root, w: w}
}
func (f *fixture) metadata(t *testing.T, name string) Entry {
	t.Helper()
	meta, err := f.e.Stat(context.Background(), f.w.ID, f.w.Revision, name)
	if err != nil {
		t.Fatal(err)
	}
	return meta
}
func (f *fixture) stage(t *testing.T, name string, data []byte, create bool) (string, WriteSpec) {
	t.Helper()
	sum := sha256.Sum256(data)
	spec := WriteSpec{Path: name, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), Create: create}
	if !create {
		spec.BaseVersion = f.metadata(t, name).Version
	}
	id := NewID(time.Now())
	op, err := f.e.BeginWrite(context.Background(), f.w.ID, 1, id, spec)
	if err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset < len(data); {
		end := offset + ChunkLimit
		if end > len(data) {
			end = len(data)
		}
		op, err = f.e.Append(context.Background(), f.w.ID, 1, id, int64(offset), data[offset:end])
		if err != nil {
			t.Fatal(err)
		}
		offset = end
	}
	if op.State != "ready" {
		t.Fatalf("not ready: %+v", op)
	}
	return id, spec
}
func (f *fixture) read(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.root, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || ErrorCode(err) != code {
		t.Fatalf("want %s, got %v (%s)", code, err, ErrorCode(err))
	}
}

func TestConfinedReadsAndStableVersions(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(f.root, "code.go"), []byte("package fixture\n"), 0750)
	os.WriteFile(filepath.Join(f.dir, "outside"), []byte("outside-private"), 0600)
	os.Symlink("../outside", filepath.Join(f.root, "escape"))
	for _, p := range []string{"../outside", "/etc/passwd", "a/../code.go", "code.go/..", "bad\x00path"} {
		_, err := f.e.OpenRead(ctx, f.w.ID, 1, p, "")
		wantCode(t, err, "INVALID_PATH")
	}
	_, err := f.e.OpenRead(ctx, f.w.ID, 1, "escape", "")
	wantCode(t, err, "FILE_UNAVAILABLE")
	if err := unix.Mkfifo(filepath.Join(f.root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	_, err = f.e.OpenRead(ctx, f.w.ID, 1, "fifo", "")
	wantCode(t, err, "SPECIAL_FILE")
	if time.Since(started) > time.Second {
		t.Fatal("FIFO open blocked")
	}
	meta := f.metadata(t, "code.go")
	if meta.Mode != 0750 || meta.SHA256 == "" {
		t.Fatal(meta)
	}
	reader, err := f.e.OpenRead(ctx, f.w.ID, 1, "code.go", meta.Version)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	b, err := reader.ReadAt(ctx, 0, ChunkLimit)
	if err != nil || string(b) != "package fixture\n" {
		t.Fatalf("read %q %v", b, err)
	}
	os.WriteFile(filepath.Join(f.root, "code.go"), []byte("external update\n"), 0750)
	b, err = reader.ReadAt(ctx, 0, 1)
	// On filesystems with coarse timestamps an immediate same-length edit may
	// retain metadata. A pinned small-file snapshot must still return old bytes.
	if err != nil {
		wantCode(t, err, "FILE_CHANGED")
	} else if string(b) != "p" {
		t.Fatal("read mixed a new file body into the old version")
	}
	reader.Close()
	reader.Close()
	_, err = f.e.OpenRead(ctx, f.w.ID, 2, "code.go", "")
	wantCode(t, err, "STALE_WORKSPACE")
	list, err := f.e.List(ctx, f.w.ID, 1, ".", false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Entries) != 3 {
		t.Fatal(list)
	}
}

func TestAtomicWriteDuplicateChunksAndIdempotentResult(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	original := []byte("original\n")
	os.WriteFile(filepath.Join(f.root, "script.sh"), original, 0750)
	data := bytes.Repeat([]byte("new content\n"), 6000)
	id, spec := f.stage(t, "script.sh", data, false)
	if !bytes.Equal(f.read(t, "script.sh"), original) {
		t.Fatal("staged upload changed target")
	}
	ack, err := f.e.Append(ctx, f.w.ID, 1, id, 0, data[:ChunkLimit])
	if err != nil || ack.State != "ready" {
		t.Fatal(ack, err)
	}
	_, err = f.e.Append(ctx, f.w.ID, 1, id, 0, bytes.Repeat([]byte("x"), ChunkLimit))
	wantCode(t, err, "CHUNK_MISMATCH")
	_, err = f.e.BeginWrite(ctx, f.w.ID, 1, id, WriteSpec{Path: "other", BaseVersion: spec.BaseVersion, Size: spec.Size, SHA256: spec.SHA256})
	wantCode(t, err, "ID_REUSED")
	op, err := f.e.Commit(ctx, f.w.ID, 1, id)
	if err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	if !bytes.Equal(f.read(t, "script.sh"), data) {
		t.Fatal("saved bytes differ")
	}
	if f.metadata(t, "script.sh").Mode != 0750 || f.metadata(t, "script.sh").Version != op.Version {
		t.Fatal("mode/version differs")
	}
	backup, err := os.ReadFile(filepath.Join(f.e.dir, "history", id+".bak"))
	if err != nil || !bytes.Equal(backup, original) {
		t.Fatal("history missing", err)
	}
	os.WriteFile(filepath.Join(f.root, "script.sh"), []byte("a later edit"), 0750)
	again, err := f.e.Commit(ctx, f.w.ID, 1, id)
	if err != nil || again.Version != op.Version {
		t.Fatal(again, err)
	}
	if string(f.read(t, "script.sh")) != "a later edit" {
		t.Fatal("retry overwrote a later edit")
	}
}

func TestExternalConflictAndConcurrentSaves(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(f.root, "main.go"), []byte("base"), 0640)
	first, _ := f.stage(t, "main.go", []byte("first"), false)
	second, _ := f.stage(t, "main.go", []byte("second"), false)
	var wg sync.WaitGroup
	var mu sync.Mutex
	success, conflict := 0, 0
	for _, id := range []string{first, second} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			op, err := f.e.Commit(ctx, f.w.ID, 1, id)
			mu.Lock()
			defer mu.Unlock()
			if err == nil && op.State == "committed" {
				success++
			} else if ErrorCode(err) == "CONFLICT" {
				conflict++
			} else {
				t.Errorf("commit: %v %+v", err, op)
			}
		}(id)
	}
	wg.Wait()
	if success != 1 || conflict != 1 {
		t.Fatalf("success %d conflict %d", success, conflict)
	}
	third, _ := f.stage(t, "main.go", []byte("third"), false)
	os.WriteFile(filepath.Join(f.root, "main.go"), []byte("Codex external change"), 0640)
	_, err := f.e.Commit(ctx, f.w.ID, 1, third)
	wantCode(t, err, "CONFLICT")
	if string(f.read(t, "main.go")) != "Codex external change" {
		t.Fatal("external edit was overwritten")
	}
}

func TestCreateNeverOverwritesAndRejectsIncompleteOrInvalidContent(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	sum := sha256.Sum256([]byte("two chunks"))
	id := NewID(time.Now())
	spec := WriteSpec{Path: "new.txt", Size: 10, SHA256: hex.EncodeToString(sum[:]), Create: true}
	_, err := f.e.BeginWrite(ctx, f.w.ID, 1, id, spec)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Commit(ctx, f.w.ID, 1, id)
	wantCode(t, err, "NOT_READY")
	_, err = f.e.Append(ctx, f.w.ID, 1, id, 4, []byte("x"))
	wantCode(t, err, "INVALID_OFFSET")
	_, err = f.e.Append(ctx, f.w.ID, 1, id, 0, []byte("wrong data"))
	wantCode(t, err, "HASH_MISMATCH")
	if _, err = os.Stat(filepath.Join(f.root, "new.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid upload became visible")
	}
	fresh, _ := f.stage(t, "new.txt", []byte("valid"), true)
	os.WriteFile(filepath.Join(f.root, "new.txt"), []byte("created elsewhere"), 0600)
	_, err = f.e.Commit(ctx, f.w.ID, 1, fresh)
	wantCode(t, err, "CONFLICT")
	if string(f.read(t, "new.txt")) != "created elsewhere" {
		t.Fatal("create overwrote target")
	}
	empty, _ := f.stage(t, "empty", nil, true)
	op, err := f.e.Commit(ctx, f.w.ID, 1, empty)
	if err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	if len(f.read(t, "empty")) != 0 {
		t.Fatal("empty file incorrect")
	}
}

func TestResultRecoveryAfterCrashWindows(t *testing.T) {
	for _, stage := range []string{"before-replace", "after-replace"} {
		t.Run(stage, func(t *testing.T) {
			f := setupFiles(t)
			ctx := context.Background()
			os.WriteFile(filepath.Join(f.root, "source"), []byte("base"), 0600)
			id, _ := f.stage(t, "source", []byte("saved"), false)
			interrupted := errors.New("simulated process interruption")
			if stage == "before-replace" {
				f.e.afterPrepare = func() error { return interrupted }
			} else {
				f.e.afterRename = func() error { return interrupted }
			}
			_, err := f.e.Commit(ctx, f.w.ID, 1, id)
			if !errors.Is(err, interrupted) {
				t.Fatal(err)
			}
			f.e.Close()
			reopened, err := Open(filepath.Join(f.dir, "state"))
			if err != nil {
				t.Fatal(err)
			}
			f.e = reopened
			t.Cleanup(func() { reopened.Close() })
			op, err := reopened.Status(ctx, f.w.ID, 1, id)
			if err != nil {
				t.Fatal(err)
			}
			expected := "committed"
			if stage == "before-replace" {
				expected = "uncertain"
			}
			if op.State != expected {
				t.Fatalf("want %s: %+v", expected, op)
			}
			wanted := "saved"
			if stage == "before-replace" {
				wanted = "base"
			}
			if string(f.read(t, "source")) != wanted {
				t.Fatal("recovery replayed a write")
			}
		})
	}
}

func TestUploadResumesAcrossRestartAndAbortIsDurable(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	data := bytes.Repeat([]byte("x"), ChunkLimit+23)
	sum := sha256.Sum256(data)
	id := NewID(time.Now())
	spec := WriteSpec{Path: "resume.bin", Create: true, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
	_, err := f.e.BeginWrite(ctx, f.w.ID, 1, id, spec)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Append(ctx, f.w.ID, 1, id, 0, data[:ChunkLimit])
	if err != nil {
		t.Fatal(err)
	}
	f.e.Close()
	next, err := Open(filepath.Join(f.dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	f.e = next
	t.Cleanup(func() { next.Close() })
	op, err := next.BeginWrite(ctx, f.w.ID, 1, id, spec)
	if err != nil || op.Offset != ChunkLimit {
		t.Fatal(op, err)
	}
	_, err = next.Append(ctx, f.w.ID, 1, id, op.Offset, data[op.Offset:])
	if err != nil {
		t.Fatal(err)
	}
	op, err = next.Commit(ctx, f.w.ID, 1, id)
	if err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	cancel, _ := f.stage(t, "cancel", []byte("not committed"), true)
	op, err = next.Abort(ctx, f.w.ID, 1, cancel)
	if err != nil || op.State != "aborted" {
		t.Fatal(op, err)
	}
	_, err = next.Commit(ctx, f.w.ID, 1, cancel)
	wantCode(t, err, "NOT_READY")
	if _, err = os.Stat(filepath.Join(f.root, "cancel")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("aborted upload is visible")
	}
	old := NewID(time.Now().Add(-8 * 24 * time.Hour))
	_, err = next.BeginWrite(ctx, f.w.ID, 1, old, spec)
	wantCode(t, err, "OPERATION_EXPIRED")
}

func TestRootReplacementAndTemporarySwapAreRejected(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	id, _ := f.stage(t, "target", []byte("new"), true)
	temp := filepath.Join(f.root, ".workdeck-write-"+id)
	os.Remove(temp)
	os.Symlink("outside", temp)
	_, err := f.e.Commit(ctx, f.w.ID, 1, id)
	wantCode(t, err, "TEMP_CHANGED")
	f.e.Close()
	os.Rename(f.root, f.root+"-old")
	os.Mkdir(f.root, 0700)
	next, err := Open(filepath.Join(f.dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { next.Close() })
	_, err = next.List(ctx, f.w.ID, 1, ".", true, "")
	wantCode(t, err, "ROOT_REPLACED")
}

func TestPathListingFiltersAndCancellation(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	os.Mkdir(filepath.Join(f.root, "dir"), 0700)
	os.WriteFile(filepath.Join(f.root, "visible.txt"), nil, 0600)
	os.WriteFile(filepath.Join(f.root, ".hidden"), nil, 0600)
	list, err := f.e.List(ctx, f.w.ID, 1, ".", false, "")
	if err != nil || len(list.Entries) != 2 || list.Entries[0].Kind != "directory" {
		t.Fatal(list, err)
	}
	list, err = f.e.List(ctx, f.w.ID, 1, ".", true, "HIDDEN")
	if err != nil || len(list.Entries) != 1 || !strings.HasPrefix(list.Entries[0].Name, ".") {
		t.Fatal(list, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = f.e.List(canceled, f.w.ID, 1, ".", false, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestDirectoryFilterSearchesBeyondUnfilteredLimit(t *testing.T) {
	f := setupFiles(t)
	for i := 0; i < 20001; i++ {
		if err := os.WriteFile(filepath.Join(f.root, fmt.Sprintf("entry-%05d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	dir, err := os.Open(f.root)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := dir.ReadDir(20001)
	dir.Close()
	if err != nil || len(entries) != 20001 {
		t.Fatal(len(entries), err)
	}
	name := entries[20000].Name()
	ordinary, err := f.e.List(context.Background(), f.w.ID, 1, ".", false, "")
	if err != nil || !ordinary.Truncated || len(ordinary.Entries) != 20000 {
		t.Fatal(len(ordinary.Entries), ordinary.Truncated, err)
	}
	filtered, err := f.e.List(context.Background(), f.w.ID, 1, ".", false, name)
	if err != nil || filtered.Truncated || len(filtered.Entries) != 1 || filtered.Entries[0].Name != name {
		t.Fatal(filtered, err)
	}
}

func TestNoReplaceAtActualCommitAndHistoryKeepsNewest(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	id, _ := f.stage(t, "race", []byte("proposed"), true)
	f.e.afterPrepare = func() error { return os.WriteFile(filepath.Join(f.root, "race"), []byte("external winner"), 0600) }
	_, err := f.e.Commit(ctx, f.w.ID, 1, id)
	wantCode(t, err, "CONFLICT")
	f.e.afterPrepare = nil
	if string(f.read(t, "race")) != "external winner" {
		t.Fatal("racing create overwritten")
	}
	os.WriteFile(filepath.Join(f.root, "history.txt"), []byte("initial"), 0600)
	var ids []string
	for i := 0; i < 12; i++ {
		id, _ := f.stage(t, "history.txt", []byte(strings.Repeat("x", i+1)), false)
		if _, err = f.e.Commit(ctx, f.w.ID, 1, id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	for i, id := range ids {
		_, err := os.Stat(filepath.Join(f.e.dir, "history", id+".bak"))
		if i < 2 && !errors.Is(err, os.ErrNotExist) {
			t.Fatal("old history retained", i, err)
		}
		if i >= 2 && err != nil {
			t.Fatal("recent history removed", i, err)
		}
	}
}

func TestWorkspaceIdentityAndUnsupportedMetadata(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	invalid := f.w
	invalid.ID = NewID(time.Now())
	invalid.User = "another-service-account"
	_, err := f.e.RegisterWorkspace(ctx, invalid)
	wantCode(t, err, "ACCOUNT_MISMATCH")
	data := []byte("linked")
	os.WriteFile(filepath.Join(f.root, "file"), data, 0600)
	os.Link(filepath.Join(f.root, "file"), filepath.Join(f.root, "hard-link"))
	sum := sha256.Sum256([]byte("new"))
	spec := WriteSpec{Path: "file", Size: 3, BaseVersion: f.metadata(t, "file").Version, SHA256: hex.EncodeToString(sum[:])}
	_, err = f.e.BeginWrite(ctx, f.w.ID, 1, NewID(time.Now()), spec)
	wantCode(t, err, "UNSUPPORTED_METADATA")
	os.Remove(filepath.Join(f.root, "hard-link"))
	if err = unix.Setxattr(filepath.Join(f.root, "file"), "user.workdeck-test", []byte("keep"), 0); err == nil {
		spec.BaseVersion = f.metadata(t, "file").Version
		_, err = f.e.BeginWrite(ctx, f.w.ID, 1, NewID(time.Now()), spec)
		wantCode(t, err, "UNSUPPORTED_METADATA")
	}
	if string(f.read(t, "file")) != "linked" {
		t.Fatal("unsupported save changed file")
	}
}

func TestIncompleteHistoryFromInterruptedSaveIsReplaced(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(f.root, "file"), []byte("original bytes"), 0600)
	id, _ := f.stage(t, "file", []byte("updated bytes"), false)
	os.MkdirAll(filepath.Join(f.e.dir, "history"), 0700)
	history := filepath.Join(f.e.dir, "history", id+".bak")
	os.WriteFile(history, []byte("incomplete"), 0600)
	if _, err := f.e.Commit(ctx, f.w.ID, 1, id); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(history)
	if err != nil || string(b) != "original bytes" {
		t.Fatalf("history %q, %v", b, err)
	}
}
