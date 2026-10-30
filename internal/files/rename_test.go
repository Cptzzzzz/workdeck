package files

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRenameChecksVersionAndNeverOverwrites(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(f.root, "source"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "source")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "target"), []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	_, err = f.e.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
	wantCode(t, err, "ALREADY_EXISTS")
	if string(f.read(t, "target")) != "external" || string(f.read(t, "source")) != "original" {
		t.Fatal("collision changed content")
	}
	if err := os.Remove(filepath.Join(f.root, "target")); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
	wantCode(t, err, "ALREADY_EXISTS")
	if err := os.WriteFile(filepath.Join(f.root, "source"), []byte("new contents"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, NewID(time.Now()), "source", "target", meta.Version)
	wantCode(t, err, "FILE_CHANGED")
	meta, err = f.e.Stat(ctx, f.w.ID, 1, "source")
	if err != nil {
		t.Fatal(err)
	}
	id = NewID(time.Now())
	op, err := f.e.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
	if err != nil || op.State != "committed" || string(f.read(t, "target")) != "new contents" {
		t.Fatal(op, err)
	}
	op, err = f.e.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
	if err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, id, "source", "other", meta.Version)
	wantCode(t, err, "ID_REUSED")
	_, err = f.e.Rename(ctx, f.w.ID, 1, NewID(time.Now()), ".", "target", meta.Version)
	wantCode(t, err, "INVALID_PATH")
	_, err = f.e.Rename(ctx, f.w.ID, 1, NewID(time.Now()), "target", "nested/other", meta.Version)
	wantCode(t, err, "INVALID_REQUEST")
	if err := os.Symlink("target", filepath.Join(f.root, "link")); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, NewID(time.Now()), "link", "link2", "anything")
	wantCode(t, err, "SPECIAL_FILE")
	if err := os.Link(filepath.Join(f.root, "target"), filepath.Join(f.root, "hardlink")); err != nil {
		t.Fatal(err)
	}
	meta, err = f.e.Stat(ctx, f.w.ID, 1, "target")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, NewID(time.Now()), "target", "renamed", meta.Version)
	wantCode(t, err, "FILE_CHANGED")
}

func TestRenameJournalRecoveryDoesNotReplayDuringStatus(t *testing.T) {
	for _, moved := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepared", true: "moved"}[moved], func(t *testing.T) {
			f := setupFiles(t)
			ctx := context.Background()
			id := NewID(time.Now())
			if err := os.Mkdir(filepath.Join(f.root, "source"), 0700); err != nil {
				t.Fatal(err)
			}
			meta, err := f.e.Stat(ctx, f.w.ID, 1, "source")
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Lstat(filepath.Join(f.root, "source"))
			if err != nil {
				t.Fatal(err)
			}
			original := identity(info)
			plan := directoryPlan{Source: "source", Path: "target", Device: original.Device, Inode: original.Inode, Original: original}
			raw, _ := json.Marshal(plan)
			fp := fingerprint(struct {
				Workspace                     string
				Revision                      int64
				Kind, Source, Target, Version string
			}{f.w.ID, 1, "entry.rename", "source", "target", meta.Version})
			_, err = f.e.db.Exec(`INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, f.w.ID, 1, "entry.rename", fp, string(raw), time.Now().UnixMilli(), time.Now().UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			if moved {
				if err = os.Rename(filepath.Join(f.root, "source"), filepath.Join(f.root, "target")); err != nil {
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
			op, err := next.MutationStatus(ctx, f.w.ID, 1, id)
			if err != nil {
				t.Fatal(err)
			}
			if moved && op.State != "committed" || !moved && op.State != "prepared" {
				t.Fatal(op)
			}
			if !moved {
				if _, err = os.Stat(filepath.Join(f.root, "target")); !os.IsNotExist(err) {
					t.Fatal("status unexpectedly moved source")
				}
				op, err = next.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
				if err != nil || op.State != "committed" {
					t.Fatal(op, err)
				}
			}
		})
	}
}

func TestRenameRecoveryRejectsReplacedSource(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	id := NewID(time.Now())
	if err := os.WriteFile(filepath.Join(f.root, "source"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "source")
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(f.root, "source"))
	if err != nil {
		t.Fatal(err)
	}
	original := identity(info)
	raw, _ := json.Marshal(directoryPlan{Source: "source", Path: "target", Device: original.Device, Inode: original.Inode, Original: original})
	fp := fingerprint(struct {
		Workspace                     string
		Revision                      int64
		Kind, Source, Target, Version string
	}{f.w.ID, 1, "entry.rename", "source", "target", meta.Version})
	_, err = f.e.db.Exec(`INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, f.w.ID, 1, "entry.rename", fp, string(raw), time.Now().UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(f.root, "source"), filepath.Join(f.root, "old")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "source"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.Rename(ctx, f.w.ID, 1, id, "source", "target", meta.Version)
	wantCode(t, err, "RESULT_UNCERTAIN")
	if string(f.read(t, "source")) != "replacement" {
		t.Fatal("replacement moved")
	}
	if _, err = os.Stat(filepath.Join(f.root, "target")); !os.IsNotExist(err) {
		t.Fatal("unexpected destination")
	}
}

func TestRenameRecoveryDoesNotMistakeHardLinkForMove(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	id := NewID(time.Now())
	if err := os.WriteFile(filepath.Join(f.root, "source"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "source")
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(f.root, "source"))
	if err != nil {
		t.Fatal(err)
	}
	original := identity(info)
	raw, _ := json.Marshal(directoryPlan{Source: "source", Path: "target", Device: original.Device, Inode: original.Inode, Original: original})
	fp := fingerprint(struct {
		Workspace                     string
		Revision                      int64
		Kind, Source, Target, Version string
	}{f.w.ID, 1, "entry.rename", "source", "target", meta.Version})
	_, err = f.e.db.Exec(`INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, f.w.ID, 1, "entry.rename", fp, string(raw), time.Now().UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Link(filepath.Join(f.root, "source"), filepath.Join(f.root, "target")); err != nil {
		t.Fatal(err)
	}
	op, err := f.e.MutationStatus(ctx, f.w.ID, 1, id)
	if ErrorCode(err) != "RESULT_UNCERTAIN" || op.State != "uncertain" {
		t.Fatal(op, err)
	}
	if string(f.read(t, "source")) != "data" || string(f.read(t, "target")) != "data" {
		t.Fatal("status changed data")
	}
}
