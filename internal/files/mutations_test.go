package files

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestCreateDirectoryNoOverwriteAndScopedIdempotency(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "parent"), 0700); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	op, err := f.e.CreateDirectory(ctx, f.w.ID, 1, id, "parent/new")
	if err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	if info, err := os.Stat(filepath.Join(f.root, "parent/new")); err != nil || !info.IsDir() {
		t.Fatal(info, err)
	}
	again, err := f.e.CreateDirectory(ctx, f.w.ID, 1, id, "parent/new")
	if err != nil || again.State != "committed" {
		t.Fatal(again, err)
	}
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, id, "parent/other")
	wantCode(t, err, "ID_REUSED")
	if err = os.WriteFile(filepath.Join(f.root, "existing"), []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	collision := NewID(time.Now())
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, collision, "existing")
	wantCode(t, err, "ALREADY_EXISTS")
	if string(f.read(t, "existing")) != "external" {
		t.Fatal("target overwritten")
	}
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, collision, "existing")
	wantCode(t, err, "ALREADY_EXISTS")
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, NewID(time.Now()), "../outside")
	wantCode(t, err, "INVALID_PATH")
	if err = os.Symlink(f.dir, filepath.Join(f.root, "escape")); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, NewID(time.Now()), "escape/nope")
	wantCode(t, err, "DIRECTORY_UNAVAILABLE")
	if _, err = os.Stat(filepath.Join(f.dir, "nope")); !os.IsNotExist(err) {
		t.Fatal("created outside workspace", err)
	}
	_, err = f.e.BeginWrite(ctx, f.w.ID, 1, id, WriteSpec{Path: "new", Create: true, SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"})
	wantCode(t, err, "ID_REUSED")
	_, err = f.e.PrepareRootChange(ctx, f.w.ID, 1, id, f.root)
	wantCode(t, err, "ID_REUSED")
}

func TestDirectoryCreateConcurrentNoOverwrite(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	out := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			op, err := f.e.CreateDirectory(ctx, f.w.ID, 1, NewID(time.Now()), "same")
			if err == nil {
				out <- op.State
			} else {
				out <- ErrorCode(err)
			}
		}()
	}
	wg.Wait()
	close(out)
	committed, conflicts := 0, 0
	for value := range out {
		switch value {
		case "committed":
			committed++
		case "ALREADY_EXISTS":
			conflicts++
		default:
			t.Fatalf("unexpected outcome %s", value)
		}
	}
	if committed != 1 || conflicts != 7 {
		t.Fatal(committed, conflicts)
	}
}

func TestDirectoryJournalRecoversWithoutBlindReplay(t *testing.T) {
	for _, afterMove := range []bool{false, true} {
		t.Run(map[bool]string{false: "before_move", true: "after_move"}[afterMove], func(t *testing.T) {
			f := setupFiles(t)
			ctx := context.Background()
			id := NewID(time.Now())
			temp := ".workdeck-fixture-" + id
			target := "created"
			if err := os.Mkdir(filepath.Join(f.root, temp), 0700); err != nil {
				t.Fatal(err)
			}
			info, err := os.Lstat(filepath.Join(f.root, temp))
			if err != nil {
				t.Fatal(err)
			}
			st := info.Sys().(*syscall.Stat_t)
			plan := directoryPlan{Path: target, Temporary: temp, Device: uint64(st.Dev), Inode: st.Ino}
			raw, _ := json.Marshal(plan)
			fp := fingerprint(struct {
				Workspace  string
				Revision   int64
				Kind, Path string
			}{f.w.ID, 1, "directory.create", target})
			_, err = f.e.db.Exec(`INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, f.w.ID, 1, "directory.create", fp, string(raw), time.Now().UnixMilli(), time.Now().UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			if afterMove {
				if err = os.Rename(filepath.Join(f.root, temp), filepath.Join(f.root, target)); err != nil {
					t.Fatal(err)
				}
			}
			if err = f.e.Close(); err != nil {
				t.Fatal(err)
			}
			next, err := Open(filepath.Join(f.dir, "state"))
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			if !afterMove {
				newRoot := filepath.Join(f.dir, "other-root")
				if err = os.Mkdir(newRoot, 0700); err != nil {
					t.Fatal(err)
				}
				switchID := NewID(time.Now())
				if _, err = next.PrepareRootChange(ctx, f.w.ID, 1, switchID, newRoot); err != nil {
					t.Fatal(err)
				}
				_, err = next.CommitRootChange(ctx, f.w.ID, switchID)
				wantCode(t, err, "WORKSPACE_BUSY")
			}
			op, err := next.MutationStatus(ctx, f.w.ID, 1, id)
			if err != nil {
				t.Fatal(err)
			}
			if afterMove {
				if op.State != "committed" {
					t.Fatal(op)
				}
			} else {
				if op.State != "prepared" {
					t.Fatal(op)
				}
				if _, err = os.Stat(filepath.Join(f.root, target)); !os.IsNotExist(err) {
					t.Fatal("status performed creation")
				}
				op, err = next.CreateDirectory(ctx, f.w.ID, 1, id, target)
				if err != nil || op.State != "committed" {
					t.Fatal(op, err)
				}
			}
		})
	}
}

func TestDirectoryMutationRejectsReplacedTemporary(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	id := NewID(time.Now())
	name := "target"
	temp := ".workdeck-fixture-" + id
	if err := os.Mkdir(filepath.Join(f.root, temp), 0700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(f.root, temp))
	if err != nil {
		t.Fatal(err)
	}
	st := info.Sys().(*syscall.Stat_t)
	plan := directoryPlan{Path: name, Temporary: temp, Device: uint64(st.Dev), Inode: st.Ino}
	raw, _ := json.Marshal(plan)
	fp := fingerprint(struct {
		Workspace  string
		Revision   int64
		Kind, Path string
	}{f.w.ID, 1, "directory.create", name})
	_, err = f.e.db.Exec(`INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, f.w.ID, 1, "directory.create", fp, string(raw), time.Now().UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(f.root, temp), filepath.Join(f.root, "original")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(f.root, temp), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, temp, "external"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.CreateDirectory(ctx, f.w.ID, 1, id, name)
	wantCode(t, err, "RESULT_UNCERTAIN")
	if _, err = os.Stat(filepath.Join(f.root, name)); !os.IsNotExist(err) {
		t.Fatal("moved an unrelated directory", err)
	}
	data, err := os.ReadFile(filepath.Join(f.root, temp, "external"))
	if err != nil || string(data) != "preserve" {
		t.Fatal("external data changed", err)
	}
}
