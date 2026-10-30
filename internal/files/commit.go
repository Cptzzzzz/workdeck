package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

func (e *Engine) Commit(ctx context.Context, workspace string, revision int64, id string) (Operation, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	rec, err := e.loadOperation(ctx, id)
	if err != nil {
		return Operation{}, err
	}
	if err = binding(rec, workspace, revision); err != nil {
		return Operation{}, err
	}
	if rec.State == "committed" {
		return rec.Operation, nil
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return rec.Operation, err
	}
	defer release()
	if rec.State == "committing" || rec.State == "uncertain" {
		return e.recoverCommit(ctx, r, &rec)
	}
	if rec.State != "ready" {
		return rec.Operation, fail("NOT_READY", "文件内容尚未完整确认，不能提交")
	}
	f, err := e.openTemporary(r, rec)
	if err != nil {
		return rec.Operation, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return rec.Operation, err
	}
	if info.Size() != rec.plan.Size {
		return rec.Operation, fail("TEMP_CHANGED", "上传临时文件长度已改变")
	}
	digest, err := digestReader(contextReader{ctx, f})
	if err != nil {
		return rec.Operation, err
	}
	if digest != rec.plan.SHA256 {
		return rec.Operation, fail("HASH_MISMATCH", "临时文件摘要已改变，请重新上传")
	}
	if rec.plan.Create {
		if _, err = r.root.Lstat(rec.plan.Path); err == nil {
			return e.conflict(ctx, r, &rec, "目标文件已出现，请另取文件名")
		}
		if !errors.Is(err, os.ErrNotExist) {
			return rec.Operation, err
		}
	} else {
		current, err := e.openWritableBase(ctx, workspace, revision, rec.plan.Path)
		if err != nil {
			return e.conflict(ctx, r, &rec, "原文件已删除、替换或无法安全保存")
		}
		if current.Metadata.Version != rec.plan.BaseVersion {
			current.Close()
			return e.conflict(ctx, r, &rec, "文件已被其他程序修改，请先比较差异")
		}
		err = e.backup(ctx, rec, current)
		current.Close()
		if err != nil {
			return rec.Operation, err
		}
		original := rec.plan.Original
		if original == nil {
			return rec.Operation, fail("INVALID_STATE", "原文件权限记录缺失")
		}
		if err = f.Chown(int(original.UID), int(original.GID)); err != nil {
			return rec.Operation, fail("METADATA_FAILED", "无法保留原文件账户和权限，请另存")
		}
		if err = f.Chmod(os.FileMode(original.Mode).Perm()); err != nil {
			return rec.Operation, err
		}
	}
	if err = f.Sync(); err != nil {
		return rec.Operation, err
	}
	// Recheck after writing the history copy; unrelated editors do not participate
	// in our lock, so the version check must stay as close to replacement as possible.
	if !rec.plan.Create {
		current, err := e.openWritableBase(ctx, workspace, revision, rec.plan.Path)
		if err != nil {
			return e.conflict(ctx, r, &rec, "原文件在提交前发生改变")
		}
		same := current.Metadata.Version == rec.plan.BaseVersion
		current.Close()
		if !same {
			return e.conflict(ctx, r, &rec, "文件在提交前被其他程序修改")
		}
	}
	if err = ctx.Err(); err != nil {
		return rec.Operation, err
	}
	if err = e.storeState(ctx, &rec, "committing", rec.Offset, "", nil); err != nil {
		return rec.Operation, err
	}
	if e.afterPrepare != nil {
		if err = e.afterPrepare(); err != nil {
			return rec.Operation, err
		}
	}
	if rec.plan.Create {
		// Linking the complete temporary inode is atomic and fails if a target
		// exists. Root.Rename alone cannot provide no-replace creation semantics.
		err = r.root.Link(rec.temporary, rec.plan.Path)
		if errors.Is(err, os.ErrExist) {
			return e.conflict(ctx, r, &rec, "目标文件在提交时已出现，请另取文件名")
		}
		if err == nil {
			err = r.root.Remove(rec.temporary)
		}
	} else {
		err = r.root.Rename(rec.temporary, rec.plan.Path)
	}
	if err != nil {
		// Even an interrupted create may already have linked its target. Recover by
		// identity and content rather than declaring failure and blindly retrying.
		return e.recoverCommit(ctx, r, &rec)
	}
	if e.afterRename != nil {
		if err = e.afterRename(); err != nil {
			return rec.Operation, err
		}
	}
	if err = syncParent(r, rec.plan.Path); err != nil {
		return rec.Operation, fail("RESULT_UNCERTAIN", "文件已替换，但持久化确认失败，请核对结果")
	}
	info, err = f.Stat()
	if err != nil {
		return rec.Operation, err
	}
	sum := ""
	if info.Size() <= TextLimit {
		sum = rec.plan.SHA256
	}
	version := versionFor(identity(info), sum)
	if err = e.storeState(ctx, &rec, "committed", rec.Offset, version, nil); err != nil {
		return rec.Operation, fail("RESULT_UNCERTAIN", "文件已保存但结果记录尚未确认，请查询操作状态")
	}
	e.pruneHistory(ctx, rec)
	return rec.Operation, nil
}

func (e *Engine) conflict(ctx context.Context, r *workspaceHandle, rec *operationRecord, message string) (Operation, error) {
	reason := &Error{"CONFLICT", message}
	if err := e.storeState(ctx, rec, "conflict", rec.Offset, "", reason); err != nil {
		return rec.Operation, err
	}
	e.removeTemporary(r, *rec)
	return rec.Operation, reason
}

func (e *Engine) recoverCommit(ctx context.Context, r *workspaceHandle, rec *operationRecord) (Operation, error) {
	reader, err := e.OpenRead(ctx, rec.WorkspaceID, rec.Revision, rec.plan.Path, "")
	matched := false
	version := ""
	if err == nil {
		if reader.original.Device == rec.temporaryDevice && reader.original.Inode == rec.temporaryInode && reader.Metadata.Size == rec.plan.Size {
			digest := reader.Metadata.SHA256
			if digest == "" {
				_, err = reader.file.Seek(0, io.SeekStart)
				if err == nil {
					digest, err = digestReader(contextReader{ctx, reader.file})
				}
			}
			matched = err == nil && digest == rec.plan.SHA256
			version = reader.Metadata.Version
		}
		reader.Close()
	}
	if matched {
		e.removeTemporary(r, *rec)
		if err = syncParent(r, rec.plan.Path); err != nil {
			return rec.Operation, fail("RESULT_UNCERTAIN", "文件内容匹配，但尚未确认持久化")
		}
		// A recovered create may have had a second temporary hard link. Recompute
		// after removing that registered alias so its final identity matches Stat.
		if meta, statErr := e.Stat(ctx, rec.WorkspaceID, rec.Revision, rec.plan.Path); statErr == nil {
			version = meta.Version
		}
		err = e.storeState(ctx, rec, "committed", rec.Offset, version, nil)
		return rec.Operation, err
	}
	reason := &Error{"RESULT_UNCERTAIN", "无法确认中断前的提交结果，请比较当前文件或另存，勿重复覆盖"}
	if err = e.storeState(ctx, rec, "uncertain", rec.Offset, "", reason); err != nil {
		return rec.Operation, err
	}
	return rec.Operation, nil
}

func syncParent(r *workspaceHandle, name string) error {
	dir, err := r.root.Open(path.Dir(name))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (e *Engine) backup(ctx context.Context, rec operationRecord, reader *Reader) error {
	if reader.Metadata.Size > TextLimit {
		return nil
	}
	dir := filepath.Join(e.dir, "history")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	temporary := ".history-" + NewID(e.now())
	f, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	ident := identity(info)
	defer e.removeTemporary(&workspaceHandle{root: root}, operationRecord{temporary: temporary, temporaryDevice: ident.Device, temporaryInode: ident.Inode})
	if _, err = io.Copy(f, contextReader{ctx, bytes.NewReader(reader.snapshot)}); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	// An incomplete history copy left by a crash must never be accepted as the
	// old version. Replace only after this new private copy has been synced.
	if err = root.Rename(temporary, rec.ID+".bak"); err != nil {
		return err
	}
	parent, err := root.Open(".")
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func (e *Engine) pruneHistory(ctx context.Context, rec operationRecord) {
	dir := filepath.Join(e.dir, "history")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type backup struct {
		name           string
		size, modified int64
	}
	files := []backup{}
	for _, item := range entries {
		id := strings.TrimSuffix(item.Name(), ".bak")
		if !strings.HasSuffix(item.Name(), ".bak") || !validID(id) {
			continue
		}
		var exists int
		if e.db.QueryRowContext(ctx, `SELECT count(*) FROM operations WHERE id=?`, id).Scan(&exists) != nil || exists != 1 {
			continue
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, backup{item.Name(), info.Size(), info.ModTime().UnixNano()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified > files[j].modified })
	rows, err := e.db.QueryContext(ctx, `SELECT id FROM operations WHERE workspace_id=? AND revision=? AND json_extract(spec,'$.path')=? ORDER BY created_at DESC`, rec.WorkspaceID, rec.Revision, rec.plan.Path)
	if err != nil {
		return
	}
	same := map[string]bool{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			same[id+".bak"] = true
		}
	}
	rows.Close()
	kept, seen := 0, 0
	var keptBytes int64
	for _, file := range files {
		extra := false
		if same[file.name] {
			seen++
			extra = seen > 10
		}
		if kept >= 1000 || keptBytes+file.size > 256<<20 || extra {
			_ = os.Remove(filepath.Join(dir, file.name))
			continue
		}
		kept++
		keptBytes += file.size
	}
}
