package files

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path"
	"syscall"

	"golang.org/x/sys/unix"
)

type directoryPlan struct {
	Path      string         `json:"path"`
	Temporary string         `json:"temporary"`
	Source    string         `json:"source,omitempty"`
	Device    uint64         `json:"device"`
	Inode     uint64         `json:"inode"`
	Original  fileIdentity   `json:"original,omitempty"`
	Count     int            `json:"count,omitempty"`
	Dirs      int            `json:"dirs,omitempty"`
	Bytes     int64          `json:"bytes,omitempty"`
	Recursive bool           `json:"recursive,omitempty"`
	Anchors   []deleteAnchor `json:"anchors,omitempty"`
	MountID   uint64         `json:"mount_id,omitempty"`
}
type mutationRecord struct {
	Operation
	fingerprint string
	plan        directoryPlan
}

func (e *Engine) mutation(ctx context.Context, id string) (mutationRecord, error) {
	var m mutationRecord
	var raw, code, message string
	err := e.db.QueryRowContext(ctx, `SELECT id,workspace_id,revision,kind,fingerprint,state,spec,error_code,error_message FROM mutations WHERE id=?`, id).Scan(&m.ID, &m.WorkspaceID, &m.Revision, &m.Kind, &m.fingerprint, &m.State, &raw, &code, &message)
	if errors.Is(err, sql.ErrNoRows) {
		return m, fail("OPERATION_NOT_FOUND", "操作记录不存在或已过期")
	}
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal([]byte(raw), &m.plan); err != nil {
		return m, err
	}
	if code != "" {
		m.Error = &Error{Code: code, Message: message}
	}
	return m, nil
}
func (e *Engine) mutationState(ctx context.Context, m *mutationRecord, state string, reason *Error) error {
	code, message := "", ""
	if reason != nil {
		code, message = reason.Code, reason.Message
	}
	_, err := e.db.ExecContext(ctx, `UPDATE mutations SET state=?,error_code=?,error_message=?,updated_at=? WHERE id=?`, state, code, message, e.now().UnixMilli(), m.ID)
	if err == nil {
		m.State = state
		m.Error = reason
	}
	return err
}
func sameDirectory(info os.FileInfo, plan directoryPlan) bool {
	if info == nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint64(stat.Dev) == plan.Device && stat.Ino == plan.Inode
}

// CreateDirectory stages a private inode and journals its identity before an
// atomic, no-replace rename. The same operation ID can be safely reconciled
// after a lost response or process restart; a different target cannot reuse it.
func (e *Engine) CreateDirectory(ctx context.Context, workspace string, revision int64, id, name string) (Operation, error) {
	if !validID(id) {
		return Operation{}, fail("INVALID_ID", "操作标识无效")
	}
	if err := validPath(name, false); err != nil {
		return Operation{}, err
	}
	fp := fingerprint(struct {
		Workspace  string
		Revision   int64
		Kind, Path string
	}{workspace, revision, "directory.create", name})
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
			return m.Operation, fail("RESULT_UNCERTAIN", "目录创建结果需要人工核对")
		}
		return e.reconcileDirectory(ctx, &m, true)
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
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return Operation{}, err
	}
	defer release()
	var pending int
	if err := e.db.QueryRowContext(ctx, `SELECT count(*) FROM mutations WHERE state IN ('prepared','uncertain','deleting')`).Scan(&pending); err != nil {
		return Operation{}, err
	}
	if pending >= 64 {
		return Operation{}, fail("QUOTA_EXCEEDED", "待确认的文件操作过多，请先核对已有操作")
	}
	if _, statErr := r.root.Lstat(name); statErr == nil {
		reason := &Error{Code: "ALREADY_EXISTS", Message: "目标已存在，请另取文件夹名称"}
		raw, marshalErr := json.Marshal(directoryPlan{Path: name})
		if marshalErr != nil {
			return Operation{}, marshalErr
		}
		_, err = e.db.ExecContext(ctx, `INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,error_code,error_message,created_at,updated_at) VALUES(?,?,?,?,?,'conflict',?,?,?,?,?)`, id, workspace, revision, "directory.create", fp, string(raw), reason.Code, reason.Message, e.now().UnixMilli(), e.now().UnixMilli())
		if err != nil {
			return Operation{}, err
		}
		return Operation{ID: id, WorkspaceID: workspace, Revision: revision, Kind: "directory.create", State: "conflict", Error: reason}, reason
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Operation{}, fail("DIRECTORY_UNAVAILABLE", "无法检查目标目录")
	}
	temp := path.Join(path.Dir(name), ".workdeck-mkdir-"+NewID(e.now()))
	if err = r.root.Mkdir(temp, 0755); err != nil {
		return Operation{}, fail("DIRECTORY_UNAVAILABLE", "无法在目标目录创建文件夹")
	}
	info, err := r.root.Lstat(temp)
	if err != nil {
		return Operation{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() {
		return Operation{}, fail("IO_ERROR", "暂存目录身份无效")
	}
	plan := directoryPlan{Path: name, Temporary: temp, Device: uint64(stat.Dev), Inode: stat.Ino}
	persisted := false
	defer func() {
		if !persisted {
			if current, e := r.root.Lstat(temp); e == nil && sameDirectory(current, plan) {
				_ = r.root.Remove(temp)
				_ = syncParent(r, temp)
			}
		}
	}()
	if err = syncParent(r, temp); err != nil {
		return Operation{}, err
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		return Operation{}, err
	}
	_, err = e.db.ExecContext(ctx, `INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, workspace, revision, "directory.create", fp, string(raw), e.now().UnixMilli(), e.now().UnixMilli())
	if err != nil {
		return Operation{}, err
	}
	persisted = true
	m = mutationRecord{Operation: Operation{ID: id, WorkspaceID: workspace, Revision: revision, Kind: "directory.create", State: "prepared"}, fingerprint: fp, plan: plan}
	return e.applyDirectory(ctx, r, &m, true)
}

func (e *Engine) reconcileDirectory(ctx context.Context, m *mutationRecord, apply bool) (Operation, error) {
	r, release, err := e.acquire(ctx, m.WorkspaceID, m.Revision)
	if err != nil {
		return m.Operation, err
	}
	defer release()
	return e.applyDirectory(ctx, r, m, apply)
}
func (e *Engine) applyDirectory(ctx context.Context, r *workspaceHandle, m *mutationRecord, apply bool) (Operation, error) {
	target, targetErr := r.root.Lstat(m.plan.Path)
	temp, tempErr := r.root.Lstat(m.plan.Temporary)
	if targetErr == nil && sameDirectory(target, m.plan) {
		if err := syncParent(r, m.plan.Path); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "目录已创建，但磁盘同步未确认")
		}
		if err := e.mutationState(ctx, m, "committed", nil); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "目录已创建，结果记录尚未确认")
		}
		return m.Operation, nil
	}
	if tempErr == nil && sameDirectory(temp, m.plan) {
		if targetErr == nil {
			reason := &Error{Code: "ALREADY_EXISTS", Message: "目标已存在，请另取文件夹名称"}
			if err := e.mutationState(ctx, m, "conflict", reason); err != nil {
				return m.Operation, err
			}
			return m.Operation, reason
		}
		if !errors.Is(targetErr, os.ErrNotExist) {
			return m.Operation, fail("DIRECTORY_UNAVAILABLE", "无法检查目标目录")
		}
		if !apply {
			return m.Operation, nil
		}
		if err := ctx.Err(); err != nil {
			return m.Operation, err
		}
		parent, err := r.root.Open(path.Dir(m.plan.Path))
		if err != nil {
			return m.Operation, fail("DIRECTORY_UNAVAILABLE", "目标目录不可访问")
		}
		defer parent.Close()
		err = unix.Renameat2(int(parent.Fd()), path.Base(m.plan.Temporary), int(parent.Fd()), path.Base(m.plan.Path), unix.RENAME_NOREPLACE)
		if errors.Is(err, unix.EEXIST) {
			reason := &Error{Code: "ALREADY_EXISTS", Message: "目标已存在，请另取文件夹名称"}
			if e2 := e.mutationState(ctx, m, "conflict", reason); e2 != nil {
				return m.Operation, e2
			}
			return m.Operation, reason
		}
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) || errors.Is(err, unix.EOPNOTSUPP) {
			reason := &Error{Code: "UNSUPPORTED_FILESYSTEM", Message: "当前文件系统不支持安全创建目录"}
			if e2 := e.mutationState(ctx, m, "failed", reason); e2 != nil {
				return m.Operation, e2
			}
			return m.Operation, reason
		}
		if err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "目录创建结果未确认，请查询操作状态")
		}
		if err = parent.Sync(); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "目录已创建，但磁盘同步未确认")
		}
		if err = e.mutationState(ctx, m, "committed", nil); err != nil {
			return m.Operation, fail("RESULT_UNCERTAIN", "目录已创建，结果记录尚未确认")
		}
		return m.Operation, nil
	}
	if targetErr != nil && !errors.Is(targetErr, os.ErrNotExist) {
		return m.Operation, fail("DIRECTORY_UNAVAILABLE", "无法检查目录创建结果")
	}
	if tempErr != nil && !errors.Is(tempErr, os.ErrNotExist) {
		return m.Operation, fail("DIRECTORY_UNAVAILABLE", "无法检查暂存目录")
	}
	if err := e.mutationState(ctx, m, "uncertain", &Error{Code: "RESULT_UNCERTAIN", Message: "目录创建结果不明确，请检查目标"}); err != nil {
		return m.Operation, err
	}
	return m.Operation, fail("RESULT_UNCERTAIN", "目录创建结果不明确，请检查目标")
}

// MutationStatus is read-only with respect to directory entries; it may
// reconcile a journal record after a completed rename, but never executes it.
func (e *Engine) MutationStatus(ctx context.Context, workspace string, revision int64, id string) (Operation, error) {
	if !validID(id) {
		return Operation{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err != nil {
		return Operation{}, err
	}
	if m.WorkspaceID != workspace || m.Revision != revision {
		return Operation{}, fail("OPERATION_SCOPE", "操作不属于当前工作区修订")
	}
	if m.State == "prepared" {
		switch m.Kind {
		case "directory.create":
			return e.reconcileDirectory(ctx, &m, false)
		case "entry.rename":
			return e.reconcileRename(ctx, &m, false)
		case "entry.delete":
			return m.Operation, nil
		default:
			return m.Operation, fail("INVALID_STATE", "未知的文件操作类型")
		}
	}
	return m.Operation, nil
}
