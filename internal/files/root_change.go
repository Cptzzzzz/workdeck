package files

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// RootChange is retained separately from file mutations because it remains
// queryable against the previous revision after the active root has changed.
type RootChange struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspace_id"`
	OldRevision int64     `json:"old_revision"`
	State       string    `json:"state"`
	Candidate   Workspace `json:"candidate"`
	fingerprint string
}

func (e *Engine) rootChange(ctx context.Context, id string) (RootChange, error) {
	var change RootChange
	var candidate string
	err := e.db.QueryRowContext(ctx, `SELECT id,workspace_id,old_revision,fingerprint,state,candidate FROM root_changes WHERE id=?`, id).
		Scan(&change.ID, &change.WorkspaceID, &change.OldRevision, &change.fingerprint, &change.State, &candidate)
	if errors.Is(err, sql.ErrNoRows) {
		return change, fail("OPERATION_NOT_FOUND", "目录切换记录不存在或已过期")
	}
	if err != nil {
		return change, err
	}
	if err := json.Unmarshal([]byte(candidate), &change.Candidate); err != nil {
		return change, err
	}
	return change, nil
}

func (e *Engine) RootChangeStatus(ctx context.Context, workspace, id string) (RootChange, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	change, err := e.rootChange(ctx, id)
	if err != nil {
		return change, err
	}
	if change.WorkspaceID != workspace {
		return RootChange{}, fail("OPERATION_SCOPE", "操作不属于当前工作区")
	}
	return change, nil
}

func (e *Engine) PrepareRootChange(ctx context.Context, workspace string, revision int64, id, target string) (RootChange, error) {
	if !validID(id) || !filepath.IsAbs(target) || revision < 1 || revision == math.MaxInt64 {
		return RootChange{}, fail("INVALID_WORKSPACE", "目录切换参数无效")
	}
	fp := fingerprint(struct {
		Workspace string
		Revision  int64
		Target    string
	}{workspace, revision, target})
	e.commit.Lock()
	defer e.commit.Unlock()
	previous, err := e.rootChange(ctx, id)
	if err == nil {
		if previous.fingerprint != fp || previous.WorkspaceID != workspace {
			return RootChange{}, fail("ID_REUSED", "操作标识不能用于不同内容")
		}
		return previous, nil
	}
	if ErrorCode(err) != "OPERATION_NOT_FOUND" {
		return RootChange{}, err
	}
	var conflictingID int
	if err := e.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM operations WHERE id=?) + (SELECT count(*) FROM mutations WHERE id=?)`, id, id).Scan(&conflictingID); err != nil {
		return RootChange{}, err
	}
	if conflictingID != 0 {
		return RootChange{}, fail("ID_REUSED", "操作标识不能用于不同内容")
	}
	if !freshID(id, e.now()) {
		return RootChange{}, fail("OPERATION_EXPIRED", "操作标识已过期，请重新选择目录")
	}
	current, err := e.workspaceRecord(ctx, workspace)
	if err != nil {
		return RootChange{}, err
	}
	if current.Revision != revision {
		return RootChange{}, fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	var pending int
	if err := e.db.QueryRowContext(ctx, `SELECT count(*) FROM root_changes WHERE workspace_id=? AND state='prepared'`, workspace).Scan(&pending); err != nil {
		return RootChange{}, err
	}
	if pending != 0 {
		return RootChange{}, fail("WORKSPACE_BUSY", "已有待确认的目录切换")
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return RootChange{}, fail("ROOT_UNAVAILABLE", "新目录不存在或无法访问")
	}
	root, err := os.OpenRoot(resolved)
	if err != nil {
		return RootChange{}, fail("ROOT_UNAVAILABLE", "无法打开新目录")
	}
	defer root.Close()
	info, err := root.Stat(".")
	if err != nil {
		return RootChange{}, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	candidate := current
	candidate.Root, candidate.Revision = resolved, revision+1
	candidate.Device, candidate.Inode = uint64(stat.Dev), stat.Ino
	encoded, err := json.Marshal(candidate)
	if err != nil {
		return RootChange{}, err
	}
	change := RootChange{ID: id, WorkspaceID: workspace, OldRevision: revision, State: "prepared", Candidate: candidate, fingerprint: fp}
	_, err = e.db.ExecContext(ctx, `INSERT INTO root_changes VALUES(?,?,?,?,?,?,?,?)`, id, workspace, revision, fp, change.State, string(encoded), e.now().UnixMilli(), e.now().UnixMilli())
	return change, err
}

func (e *Engine) AbortRootChange(ctx context.Context, workspace, id string) (RootChange, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	change, err := e.rootChange(ctx, id)
	if err != nil {
		return change, err
	}
	if change.WorkspaceID != workspace {
		return RootChange{}, fail("OPERATION_SCOPE", "操作不属于当前工作区")
	}
	if change.State == "committed" {
		return change, fail("ALREADY_COMMITTED", "目录已经切换，无法取消")
	}
	if change.State == "prepared" {
		_, err = e.db.ExecContext(ctx, `UPDATE root_changes SET state='aborted',updated_at=? WHERE id=? AND state='prepared'`, e.now().UnixMilli(), id)
		if err == nil {
			change.State = "aborted"
		}
	}
	return change, err
}

func (e *Engine) CommitRootChange(ctx context.Context, workspace, id string) (RootChange, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	change, err := e.rootChange(ctx, id)
	if err != nil {
		return change, err
	}
	if change.WorkspaceID != workspace {
		return RootChange{}, fail("OPERATION_SCOPE", "操作不属于当前工作区")
	}
	if change.State == "committed" {
		return change, nil
	}
	if change.State != "prepared" {
		return change, fail("INVALID_STATE", "目录切换已取消")
	}
	current, err := e.workspaceRecord(ctx, workspace)
	if err != nil {
		return change, err
	}
	if current.Revision != change.OldRevision {
		return change, fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	var pending int
	if err := e.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM operations WHERE workspace_id=? AND revision=? AND state IN ('receiving','ready','committing','uncertain')) + (SELECT count(*) FROM mutations WHERE workspace_id=? AND revision=? AND state IN ('prepared','uncertain'))`, workspace, change.OldRevision, workspace, change.OldRevision).Scan(&pending); err != nil {
		return change, err
	}
	if pending != 0 {
		return change, fail("WORKSPACE_BUSY", "请先完成或核对正在进行的文件操作")
	}
	newRoot, err := os.OpenRoot(change.Candidate.Root)
	if err != nil {
		return change, fail("ROOT_UNAVAILABLE", "新目录无法访问")
	}
	owned := false
	defer func() {
		if !owned {
			newRoot.Close()
		}
	}()
	info, err := newRoot.Stat(".")
	if err != nil {
		return change, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	if uint64(stat.Dev) != change.Candidate.Device || stat.Ino != change.Candidate.Inode {
		return change, fail("ROOT_REPLACED", "新目录已被替换，请重新选择")
	}

	// Stop accepting new readers while existing streams close. The caller can
	// cancel the wait without leaving the current root stuck in a draining state.
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return change, os.ErrClosed
	}
	old := e.roots[workspace]
	if old != nil {
		old.draining = true
	}
	e.mu.Unlock()
	locked := false
	defer func() {
		if old != nil {
			e.mu.Lock()
			old.draining = false
			e.mu.Unlock()
			if locked {
				old.mu.Unlock()
			}
		}
	}()
	if old != nil {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for !old.mu.TryLock() {
			select {
			case <-ctx.Done():
				return change, ctx.Err()
			case <-ticker.C:
			}
		}
		locked = true
	}
	if err := ctx.Err(); err != nil {
		return change, err
	}
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return change, err
	}
	defer tx.Rollback()
	candidate := change.Candidate
	result, err := tx.ExecContext(ctx, `UPDATE workspaces SET root_path=?,revision=?,device=?,inode=? WHERE id=? AND revision=?`, candidate.Root, candidate.Revision, strconv.FormatUint(candidate.Device, 10), strconv.FormatUint(candidate.Inode, 10), workspace, change.OldRevision)
	if err != nil {
		return change, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return change, err
	}
	if updated != 1 {
		return change, fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE root_changes SET state='committed',updated_at=? WHERE id=? AND state='prepared'`, e.now().UnixMilli(), id); err != nil {
		return change, err
	}
	if err = tx.Commit(); err != nil {
		// A failed commit can be ambiguous. Clear the cached handle so the next
		// request consults the durable row instead of serving a stale root.
		e.mu.Lock()
		delete(e.roots, workspace)
		e.mu.Unlock()
		if old != nil {
			old.root.Close()
		}
		return change, fail("RESULT_UNCERTAIN", "目录切换结果待确认，请查询原操作")
	}
	e.mu.Lock()
	e.roots[workspace] = &workspaceHandle{spec: candidate, root: newRoot}
	e.mu.Unlock()
	owned = true
	if old != nil {
		old.root.Close()
	}
	change.State = "committed"
	return change, nil
}
