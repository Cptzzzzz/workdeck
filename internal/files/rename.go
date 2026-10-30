package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"

	"golang.org/x/sys/unix"
)

// Rename only changes a name within one parent directory. The caller supplies
// the version it observed, and the durable journal prevents blind replay.
func (e *Engine) Rename(ctx context.Context, workspace string, revision int64, id, source, target, version string) (Operation, error) {
	if !validID(id) {
		return Operation{}, fail("INVALID_ID", "操作标识无效")
	}
	if err := validPath(source, false); err != nil {
		return Operation{}, err
	}
	if err := validPath(target, false); err != nil {
		return Operation{}, err
	}
	if source == target || path.Dir(source) != path.Dir(target) || version == "" {
		return Operation{}, fail("INVALID_REQUEST", "重命名必须在同一目录内且提供源文件版本")
	}
	fp := fingerprint(struct {
		Workspace                     string
		Revision                      int64
		Kind, Source, Target, Version string
	}{workspace, revision, "entry.rename", source, target, version})
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err == nil {
		if m.WorkspaceID != workspace || m.Revision != revision || m.fingerprint != fp {
			return Operation{}, fail("ID_REUSED", "操作标识不能用于不同内容")
		}
		if m.State == "committed" {
			return m.Operation, nil
		}
		if m.State == "conflict" || m.State == "failed" {
			return m.Operation, m.Error
		}
		if m.State != "prepared" {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名结果需要人工核对")
		}
		return e.reconcileRename(ctx, &m, true)
	}
	if ErrorCode(err) != "OPERATION_NOT_FOUND" {
		return Operation{}, err
	}
	var count int
	if err = e.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM operations WHERE id=?) + (SELECT count(*) FROM root_changes WHERE id=?)`, id, id).Scan(&count); err != nil {
		return Operation{}, err
	}
	if count != 0 {
		return Operation{}, fail("ID_REUSED", "操作标识不能用于不同内容")
	}
	if !freshID(id, e.now()) {
		return Operation{}, fail("OPERATION_EXPIRED", "操作标识已过期，请重新确认")
	}
	var pending int
	if err = e.db.QueryRowContext(ctx, `SELECT count(*) FROM mutations WHERE state IN ('prepared','uncertain','deleting')`).Scan(&pending); err != nil {
		return Operation{}, err
	}
	if pending >= 64 {
		return Operation{}, fail("QUOTA_EXCEEDED", "待确认的文件操作过多")
	}
	meta, err := e.Stat(ctx, workspace, revision, source)
	if err != nil {
		return Operation{}, err
	}
	if meta.Restricted || (meta.Kind != "file" && meta.Kind != "directory") {
		return Operation{}, fail("SPECIAL_FILE", "不支持重命名链接或特殊文件")
	}
	if meta.Version != version {
		return Operation{}, fail("FILE_CHANGED", "源文件已改变，请刷新后重新确认")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return Operation{}, err
	}
	defer release()
	info, err := r.root.Lstat(source)
	if err != nil {
		return Operation{}, fail("FILE_CHANGED", "源文件已改变")
	}
	original := identity(info)
	if versionFor(original, meta.SHA256) != version || (meta.Kind == "file" && original.Links != 1) {
		return Operation{}, fail("FILE_CHANGED", "源文件已改变或存在硬链接")
	}
	plan := directoryPlan{Path: target, Source: source, Device: original.Device, Inode: original.Inode, Original: original}
	raw, err := json.Marshal(plan)
	if err != nil {
		return Operation{}, err
	}
	_, err = e.db.ExecContext(ctx, `INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, workspace, revision, "entry.rename", fp, string(raw), e.now().UnixMilli(), e.now().UnixMilli())
	if err != nil {
		return Operation{}, err
	}
	m = mutationRecord{Operation: Operation{ID: id, WorkspaceID: workspace, Revision: revision, Kind: "entry.rename", State: "prepared"}, fingerprint: fp, plan: plan}
	return e.applyRename(ctx, r, &m, true)
}

func (e *Engine) reconcileRename(ctx context.Context, m *mutationRecord, apply bool) (Operation, error) {
	r, release, err := e.acquire(ctx, m.WorkspaceID, m.Revision)
	if err != nil {
		return m.Operation, err
	}
	defer release()
	return e.applyRename(ctx, r, m, apply)
}
func (e *Engine) applyRename(ctx context.Context, r *workspaceHandle, m *mutationRecord, apply bool) (Operation, error) {
	source, sourceErr := r.root.Lstat(m.plan.Source)
	target, targetErr := r.root.Lstat(m.plan.Path)
	sameTarget := targetErr == nil && identity(target).Device == m.plan.Device && identity(target).Inode == m.plan.Inode
	sameSource := sourceErr == nil && identity(source) == m.plan.Original
	sourceIsMoved := errors.Is(sourceErr, os.ErrNotExist) || (sourceErr == nil && (identity(source).Device != m.plan.Device || identity(source).Inode != m.plan.Inode))
	if sameTarget && sourceIsMoved {
		if err := syncParent(r, m.plan.Path); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名已执行，但磁盘同步未确认")
		}
		if err := e.mutationState(ctx, m, "committed", nil); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名结果记录尚未确认")
		}
		return m.Operation, nil
	}
	if sameSource && targetErr == nil {
		reason := &Error{Code: "ALREADY_EXISTS", Message: "目标已存在，无法重命名"}
		if err := e.mutationState(ctx, m, "conflict", reason); err != nil {
			return m.Operation, err
		}
		return m.Operation, reason
	}
	if sameSource && errors.Is(targetErr, os.ErrNotExist) {
		if !apply {
			return m.Operation, nil
		}
		if err := ctx.Err(); err != nil {
			return m.Operation, err
		}
		parent, err := r.root.Open(path.Dir(m.plan.Source))
		if err != nil {
			return m.Operation, fail("DIRECTORY_UNAVAILABLE", "无法打开父目录")
		}
		defer parent.Close()
		openedParent, parentErr := parent.Stat()
		currentParent, pathErr := r.root.Stat(path.Dir(m.plan.Source))
		if parentErr != nil || pathErr != nil || identity(openedParent).Device != identity(currentParent).Device || identity(openedParent).Inode != identity(currentParent).Inode {
			return m.Operation, fail("RESULT_UNCERTAIN", "父目录已改变，请重新核对")
		}
		var leaf unix.Stat_t
		if err := unix.Fstatat(int(parent.Fd()), path.Base(m.plan.Source), &leaf, unix.AT_SYMLINK_NOFOLLOW); err != nil || uint64(leaf.Dev) != m.plan.Original.Device || leaf.Ino != m.plan.Original.Inode || leaf.Size != m.plan.Original.Size || uint64(leaf.Nlink) != m.plan.Original.Links || leaf.Mtim.Sec*1e9+leaf.Mtim.Nsec != m.plan.Original.Mtime || leaf.Ctim.Sec*1e9+leaf.Ctim.Nsec != m.plan.Original.Ctime {
			return m.Operation, fail("RESULT_UNCERTAIN", "源文件已改变，请重新核对")
		}
		err = unix.Renameat2(int(parent.Fd()), path.Base(m.plan.Source), int(parent.Fd()), path.Base(m.plan.Path), unix.RENAME_NOREPLACE)
		if errors.Is(err, unix.EEXIST) {
			reason := &Error{Code: "ALREADY_EXISTS", Message: "目标已存在，无法重命名"}
			if e2 := e.mutationState(ctx, m, "conflict", reason); e2 != nil {
				return m.Operation, e2
			}
			return m.Operation, reason
		}
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) || errors.Is(err, unix.EOPNOTSUPP) {
			reason := &Error{Code: "UNSUPPORTED_FILESYSTEM", Message: "文件系统不支持安全重命名"}
			if e2 := e.mutationState(ctx, m, "failed", reason); e2 != nil {
				return m.Operation, e2
			}
			return m.Operation, reason
		}
		if err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名结果未确认")
		}
		if err = parent.Sync(); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名已执行，但磁盘同步未确认")
		}
		// Recheck identity: an external process may have raced the source path.
		moved, err := r.root.Lstat(m.plan.Path)
		if err != nil || identity(moved).Device != m.plan.Device || identity(moved).Inode != m.plan.Inode {
			return m.Operation, fail("RESULT_UNCERTAIN", "源文件在重命名期间发生变化，请检查目标")
		}
		if err = e.mutationState(ctx, m, "committed", nil); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "重命名结果记录尚未确认")
		}
		return m.Operation, nil
	}
	if sourceErr != nil && !errors.Is(sourceErr, os.ErrNotExist) || targetErr != nil && !errors.Is(targetErr, os.ErrNotExist) {
		return m.Operation, fail("DIRECTORY_UNAVAILABLE", "无法检查重命名结果")
	}
	reason := &Error{Code: "RESULT_UNCERTAIN", Message: "源文件或目标已改变，请人工核对"}
	if err := e.mutationState(ctx, m, "uncertain", reason); err != nil {
		return m.Operation, err
	}
	return m.Operation, reason
}
