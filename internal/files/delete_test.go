package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestPrepareDeleteSnapshotsWithoutDeleting(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(f.root, "project", "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "project", ".hidden"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "project", "sub", "file"), []byte("world!"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(f.dir, "outside")
	if err := os.WriteFile(outside, []byte("protected"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.root, "project", "link")); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "project")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), "project", meta.Version, false)
	wantCode(t, err, "DIRECTORY_NOT_EMPTY")
	id := NewID(time.Now())
	preview, err := f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, true)
	if err != nil || preview.State != "prepared" || preview.Count != 5 || preview.Directories != 2 || preview.Bytes != 11 {
		t.Fatal(preview, err)
	}
	rows, err := f.e.db.Query(`SELECT path,kind FROM delete_items WHERE operation_id=? ORDER BY seq`, id)
	if err != nil {
		t.Fatal(err)
	}
	var paths, kinds []string
	for rows.Next() {
		var p, k string
		if err := rows.Scan(&p, &k); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
		kinds = append(kinds, k)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 5 || paths[len(paths)-1] != "project" || kinds[1] != "symlink" {
		t.Fatal(paths, kinds)
	}
	if string(f.read(t, "project/sub/file")) != "world!" {
		t.Fatal("preview changed file")
	}
	if got, err := os.ReadFile(outside); err != nil || string(got) != "protected" {
		t.Fatal(string(got), err)
	}
	again, err := f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, true)
	if err != nil || again.Count != preview.Count {
		t.Fatal(again, err)
	}
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, false)
	wantCode(t, err, "ID_REUSED")
	status, err := f.e.MutationStatus(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "prepared" {
		t.Fatal(status, err)
	}
	cancelled, err := f.e.CancelDelete(ctx, f.w.ID, 1, id)
	if err != nil || cancelled.State != "aborted" {
		t.Fatal(cancelled, err)
	}
	if _, err = os.Stat(filepath.Join(f.root, "project")); err != nil {
		t.Fatal("cancel removed project", err)
	}
	again, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, true)
	if err != nil || again.State != "aborted" {
		t.Fatal(again, err)
	}
}

func TestCommitDeleteOnlyRemovesSnapshottedObjects(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(f.root, "project", "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "project", "sub", "old"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(f.dir, "outside")
	if err := os.WriteFile(outside, []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.root, "project", "link")); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "project")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, true); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "project", "sub", "new"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "partial" || status.Deleted != 2 || status.Skipped != 2 || status.Pending != 0 {
		t.Fatal(status, err)
	}
	if _, err = os.Stat(filepath.Join(f.root, "project", "sub", "old")); !os.IsNotExist(err) {
		t.Fatal("old entry remains", err)
	}
	if data, err := os.ReadFile(filepath.Join(f.root, "project", "sub", "new")); err != nil || string(data) != "new" {
		t.Fatal(string(data), err)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "safe" {
		t.Fatal(string(data), err)
	}
	outcomes, next, err := f.e.DeleteOutcomes(ctx, f.w.ID, 1, id, 0, 64)
	if err != nil || len(outcomes) != 4 || next != 4 || outcomes[3].State != "skipped" {
		t.Fatal(outcomes, next, err)
	}
	again, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || again.State != "partial" {
		t.Fatal(again, err)
	}
	if _, err = os.Stat(filepath.Join(f.root, "project", "sub", "new")); err != nil {
		t.Fatal("retry removed new item", err)
	}
}

func TestDeletePreservesReplacementAndStagesOnlyOriginal(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(f.root, "file"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "file")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "file", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(f.root, "file"), filepath.Join(f.root, "original")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "file"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "partial" || status.Skipped != 1 {
		t.Fatal(status, err)
	}
	if data, err := os.ReadFile(filepath.Join(f.root, "file")); err != nil || string(data) != "replacement" {
		t.Fatal(string(data), err)
	}
}

func TestDeleteRecoveryAfterMoveAndAfterRemoval(t *testing.T) {
	for _, afterRemoval := range []bool{false, true} {
		t.Run(fmt.Sprintf("removed_%t", afterRemoval), func(t *testing.T) {
			f := setupFiles(t)
			ctx := context.Background()
			if err := os.WriteFile(filepath.Join(f.root, "file"), []byte("old"), 0600); err != nil {
				t.Fatal(err)
			}
			meta, err := f.e.Stat(ctx, f.w.ID, 1, "file")
			if err != nil {
				t.Fatal(err)
			}
			id := NewID(time.Now())
			if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "file", meta.Version, false); err != nil {
				t.Fatal(err)
			}
			interrupted := errors.New("simulated stop")
			if afterRemoval {
				f.e.afterDeleteRemove = func(string, string) error { return interrupted }
			} else {
				f.e.afterDeleteMove = func(string, string) error { return interrupted }
			}
			if _, err = f.e.CommitDelete(ctx, f.w.ID, 1, id); !errors.Is(err, interrupted) {
				t.Fatal(err)
			}
			if err = f.e.Close(); err != nil {
				t.Fatal(err)
			}
			next, err := Open(filepath.Join(f.dir, "state"))
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			if afterRemoval {
				if err = os.WriteFile(filepath.Join(f.root, "file"), []byte("new"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			status, err := next.CommitDelete(ctx, f.w.ID, 1, id)
			if err != nil {
				t.Fatal(err)
			}
			if afterRemoval {
				if status.State != "uncertain" || status.Uncertain != 1 {
					t.Fatal(status)
				}
				data, err := os.ReadFile(filepath.Join(f.root, "file"))
				if err != nil || string(data) != "new" {
					t.Fatal(string(data), err)
				}
			} else if status.State != "committed" || status.Deleted != 1 {
				t.Fatal(status)
			}
		})
	}
}

func TestDeleteRestoresDirectoryWhenNewContentAppearsAfterMove(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "folder")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "folder", meta.Version, true); err != nil {
		t.Fatal(err)
	}
	f.e.afterDeleteMove = func(_ string, stage string) error {
		return os.WriteFile(filepath.Join(f.root, stage, "new"), []byte("keep"), 0600)
	}
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "partial" || status.Skipped != 1 {
		t.Fatal(status, err)
	}
	data, err := os.ReadFile(filepath.Join(f.root, "folder", "new"))
	if err != nil || string(data) != "keep" {
		t.Fatal(string(data), err)
	}
}

func TestDeleteBatchNeverAddsLaterEntries(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 40; i++ {
		if err := os.WriteFile(filepath.Join(f.root, "folder", fmt.Sprintf("%02d", i)), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "folder")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "folder", meta.Version, true); err != nil {
		t.Fatal(err)
	}
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "deleting" || status.Deleted != 32 {
		t.Fatal(status, err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "folder", "late"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err = f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "partial" || status.Deleted != 40 || status.Skipped != 1 {
		t.Fatal(status, err)
	}
	if data, err := os.ReadFile(filepath.Join(f.root, "folder", "late")); err != nil || string(data) != "keep" {
		t.Fatal(string(data), err)
	}
}

func TestCancelDeleteAfterBatchPreservesRemainingEntries(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 40; i++ {
		if err := os.WriteFile(filepath.Join(f.root, "folder", fmt.Sprintf("%02d", i)), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "folder")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "folder", meta.Version, true); err != nil {
		t.Fatal(err)
	}
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "deleting" || status.Deleted != 32 {
		t.Fatal(status, err)
	}
	preview, err := f.e.CancelDelete(ctx, f.w.ID, 1, id)
	if err != nil || preview.State != "partial" {
		t.Fatal(preview, err)
	}
	status, err = f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "partial" || status.Deleted != 32 || status.Skipped != 9 {
		t.Fatal(status, err)
	}
	if _, err = os.Stat(filepath.Join(f.root, "folder", "39")); err != nil {
		t.Fatal("cancelled item removed", err)
	}
}

func TestDeleteSkipsWhenAncestorIsReplacedOrStageExists(t *testing.T) {
	t.Run("ancestor replaced", func(t *testing.T) {
		f := setupFiles(t)
		ctx := context.Background()
		if err := os.Mkdir(filepath.Join(f.root, "parent"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(f.root, "parent", "file"), []byte("old"), 0600); err != nil {
			t.Fatal(err)
		}
		meta, err := f.e.Stat(ctx, f.w.ID, 1, "parent/file")
		if err != nil {
			t.Fatal(err)
		}
		id := NewID(time.Now())
		if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "parent/file", meta.Version, false); err != nil {
			t.Fatal(err)
		}
		if err = os.Rename(filepath.Join(f.root, "parent"), filepath.Join(f.root, "original-parent")); err != nil {
			t.Fatal(err)
		}
		if err = os.Mkdir(filepath.Join(f.root, "parent"), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(f.root, "parent", "file"), []byte("new"), 0600); err != nil {
			t.Fatal(err)
		}
		status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
		if err != nil || status.State != "partial" || status.Skipped != 1 {
			t.Fatal(status, err)
		}
		data, err := os.ReadFile(filepath.Join(f.root, "parent", "file"))
		if err != nil || string(data) != "new" {
			t.Fatal(string(data), err)
		}
	})
	t.Run("staging collision", func(t *testing.T) {
		f := setupFiles(t)
		ctx := context.Background()
		if err := os.WriteFile(filepath.Join(f.root, "file"), []byte("old"), 0600); err != nil {
			t.Fatal(err)
		}
		meta, err := f.e.Stat(ctx, f.w.ID, 1, "file")
		if err != nil {
			t.Fatal(err)
		}
		id := NewID(time.Now())
		if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "file", meta.Version, false); err != nil {
			t.Fatal(err)
		}
		stage := filepath.Join(f.root, fmt.Sprintf(".workdeck-delete-%s-0", id))
		if err = os.WriteFile(stage, []byte("other"), 0600); err != nil {
			t.Fatal(err)
		}
		status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
		if err != nil || status.State != "partial" || status.Skipped != 1 {
			t.Fatal(status, err)
		}
		if string(f.read(t, "file")) != "old" {
			t.Fatal("original removed")
		}
		data, err := os.ReadFile(stage)
		if err != nil || string(data) != "other" {
			t.Fatal(string(data), err)
		}
	})
}

func TestDeleteRejectsSameDeviceBindMount(t *testing.T) {
	if os.Getenv("WORKDECK_TEST_BIND_MOUNT") != "1" {
		t.Skip("requires an isolated container with mount capability")
	}
	f := setupFiles(t)
	ctx := context.Background()
	outside := filepath.Join(f.dir, "outside-mount")
	inside := filepath.Join(f.root, "project", "mounted")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(inside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "protected"), []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mount(outside, inside, "", unix.MS_BIND, ""); err != nil {
		t.Fatalf("isolated bind mount: %v", err)
	}
	defer unix.Unmount(inside, 0)
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "project")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), "project", meta.Version, true)
	wantCode(t, err, "MOUNT_BOUNDARY")
	data, err := os.ReadFile(filepath.Join(outside, "protected"))
	if err != nil || string(data) != "safe" {
		t.Fatal(string(data), err)
	}
}

func TestDeleteInterruptedStageWithReplacedParentIsUncertain(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "parent"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "parent", "file"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "parent/file")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "parent/file", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("interrupted")
	f.e.afterDeleteMove = func(_, _ string) error {
		if err := os.Rename(filepath.Join(f.root, "parent"), filepath.Join(f.root, "old-parent")); err != nil {
			return err
		}
		if err := os.Mkdir(filepath.Join(f.root, "parent"), 0700); err != nil {
			return err
		}
		return interrupted
	}
	if _, err = f.e.CommitDelete(ctx, f.w.ID, 1, id); !errors.Is(err, interrupted) {
		t.Fatal(err)
	}
	f.e.afterDeleteMove = nil
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "uncertain" || status.Uncertain != 1 || status.Skipped != 0 {
		t.Fatal(status, err)
	}
	stage := filepath.Join(f.root, "old-parent", fmt.Sprintf(".workdeck-delete-%s-0", id))
	data, err := os.ReadFile(stage)
	if err != nil || string(data) != "original" {
		t.Fatal(string(data), err)
	}
}

func TestDeleteRejectsPathThatCannotFitOutcomeFrame(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	current := filepath.Join(f.root, "project")
	if err := os.Mkdir(current, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ {
		current = filepath.Join(current, strings.Repeat("\x01", 200))
		if err := os.Mkdir(current, 0700); err != nil {
			t.Fatal(err)
		}
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "project")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "project", meta.Version, true)
	wantCode(t, err, "DELETE_LIMIT")
	if _, err = os.Stat(current); err != nil {
		t.Fatal("preview changed directory", err)
	}
	_, err = f.e.MutationStatus(ctx, f.w.ID, 1, id)
	wantCode(t, err, "OPERATION_NOT_FOUND")
}

func TestDeleteJournalExpiresFinishedDetailsWithoutReplayingOrDroppingUncertain(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	now := time.Now()
	f.e.now = func() time.Time { return now }
	for _, name := range []string{"finished", "uncertain", "trigger"} {
		if err := os.WriteFile(filepath.Join(f.root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "finished")
	if err != nil {
		t.Fatal(err)
	}
	finishedID := NewID(now)
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, finishedID, "finished", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.e.CommitDelete(ctx, f.w.ID, 1, finishedID); err != nil {
		t.Fatal(err)
	}
	meta, err = f.e.Stat(ctx, f.w.ID, 1, "uncertain")
	if err != nil {
		t.Fatal(err)
	}
	uncertainID := NewID(now)
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, uncertainID, "uncertain", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	f.e.afterDeleteRemove = func(string, string) error { return errors.New("interrupt") }
	_, _ = f.e.CommitDelete(ctx, f.w.ID, 1, uncertainID)
	f.e.afterDeleteRemove = nil
	status, err := f.e.CommitDelete(ctx, f.w.ID, 1, uncertainID)
	if err != nil || status.State != "uncertain" {
		t.Fatal(status, err)
	}
	now = now.Add(ResultLifetime + time.Hour)
	meta, err = f.e.Stat(ctx, f.w.ID, 1, "trigger")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(now), "trigger", meta.Version, false); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.DeleteStatus(ctx, f.w.ID, 1, finishedID)
	wantCode(t, err, "OPERATION_EXPIRED")
	_, _, err = f.e.DeleteOutcomes(ctx, f.w.ID, 1, finishedID, 0, 10)
	wantCode(t, err, "OPERATION_EXPIRED")
	status, err = f.e.DeleteStatus(ctx, f.w.ID, 1, uncertainID)
	if err != nil || status.State != "uncertain" {
		t.Fatal(status, err)
	}
	var count int
	if err = f.e.db.QueryRow(`SELECT count(*) FROM delete_items WHERE operation_id=?`, uncertainID).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "finished"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.CommitDelete(ctx, f.w.ID, 1, finishedID)
	wantCode(t, err, "OPERATION_EXPIRED")
	if string(f.read(t, "finished")) != "new" {
		t.Fatal("expired operation removed new file")
	}
}

func TestPrepareDeleteRejectsStaleRootSpecialAndTraversal(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.Mkdir(filepath.Join(f.root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "folder")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, "folder", "later"), []byte("later"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(filepath.Join(f.root, "folder"), 0755); err != nil {
		t.Fatal(err)
	}
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), "folder", meta.Version, true)
	wantCode(t, err, "FILE_CHANGED")
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), ".", "v", true)
	wantCode(t, err, "INVALID_PATH")
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), "../outside", "v", true)
	wantCode(t, err, "INVALID_PATH")
	if err = os.Symlink("folder", filepath.Join(f.root, "alias")); err != nil {
		t.Fatal(err)
	}
	aliasMeta, err := f.e.Stat(ctx, f.w.ID, 1, "alias/later")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, NewID(time.Now()), "alias/later", aliasMeta.Version, false)
	wantCode(t, err, "DIRECTORY_UNAVAILABLE")
	if err = unix.Mkfifo(filepath.Join(f.root, "folder", "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err = f.e.Stat(ctx, f.w.ID, 1, "folder")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	_, err = f.e.PrepareDelete(ctx, f.w.ID, 1, id, "folder", meta.Version, true)
	wantCode(t, err, "SPECIAL_FILE")
	_, err = f.e.MutationStatus(ctx, f.w.ID, 1, id)
	wantCode(t, err, "OPERATION_NOT_FOUND")
	if _, err = os.Stat(filepath.Join(f.root, "folder", "later")); err != nil {
		t.Fatal(err)
	}
}

func TestPreparedDeletePersistsAndBlocksRootSwitchUntilCancelled(t *testing.T) {
	f := setupFiles(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(f.root, "file"), []byte("value"), 0600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.e.Stat(ctx, f.w.ID, 1, "file")
	if err != nil {
		t.Fatal(err)
	}
	id := NewID(time.Now())
	preview, err := f.e.PrepareDelete(ctx, f.w.ID, 1, id, "file", meta.Version, false)
	if err != nil || preview.Count != 1 {
		t.Fatal(preview, err)
	}
	if err = f.e.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := Open(filepath.Join(f.dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	status, err := next.MutationStatus(ctx, f.w.ID, 1, id)
	if err != nil || status.State != "prepared" {
		t.Fatal(status, err)
	}
	other := filepath.Join(f.dir, "other")
	if err = os.Mkdir(other, 0700); err != nil {
		t.Fatal(err)
	}
	changeID := NewID(time.Now())
	if _, err = next.PrepareRootChange(ctx, f.w.ID, 1, changeID, other); err != nil {
		t.Fatal(err)
	}
	_, err = next.CommitRootChange(ctx, f.w.ID, changeID)
	wantCode(t, err, "WORKSPACE_BUSY")
	if _, err = next.CancelDelete(ctx, f.w.ID, 1, id); err != nil {
		t.Fatal(err)
	}
	change, err := next.CommitRootChange(ctx, f.w.ID, changeID)
	if err != nil || change.State != "committed" {
		t.Fatal(change, err)
	}
}
