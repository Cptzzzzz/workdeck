package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

const deleteBatch = 32

type DeleteStatus struct {
	DeletePreview
	Deleted   int `json:"deleted"`
	Skipped   int `json:"skipped"`
	Pending   int `json:"pending"`
	Uncertain int `json:"uncertain"`
}
type DeleteOutcome struct {
	Path  string `json:"path"`
	Kind  string `json:"kind"`
	State string `json:"state"`
	Error *Error `json:"error,omitempty"`
}
type storedDeleteItem struct {
	seq               int
	name, kind, state string
	ident             fileIdentity
}

// CommitDelete performs a bounded part of the exact snapshot previously
// confirmed. It never discovers or adds new paths to an existing operation.
func (e *Engine) CommitDelete(ctx context.Context, workspace string, revision int64, id string) (DeleteStatus, error) {
	if !validID(id) {
		return DeleteStatus{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err != nil {
		return DeleteStatus{}, err
	}
	if m.WorkspaceID != workspace || m.Revision != revision || m.Kind != "entry.delete" {
		return DeleteStatus{}, fail("OPERATION_SCOPE", "删除操作不属于当前工作区")
	}
	if m.State == "prepared" {
		if err = e.mutationState(ctx, &m, "deleting", nil); err != nil {
			return DeleteStatus{}, err
		}
	}
	if m.State == "committed" || m.State == "partial" || m.State == "aborted" || m.State == "uncertain" {
		return e.deleteStatus(ctx, m)
	}
	if m.State != "deleting" {
		return DeleteStatus{}, fail("INVALID_STATE", "删除操作无法继续")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return DeleteStatus{}, err
	}
	defer release()
	items, err := e.loadDeleteItems(ctx, id)
	if err != nil {
		return DeleteStatus{}, err
	}
	ancestors := make(map[string]fileIdentity)
	for _, item := range items {
		if item.kind == "directory" {
			ancestors[item.name] = item.ident
		}
	}
	processed := 0
	for _, item := range items {
		if item.state == "deleted" || item.state == "skipped" {
			continue
		}
		if item.state == "uncertain" {
			if err = e.mutationState(ctx, &m, "uncertain", &Error{Code: "RESULT_UNCERTAIN", Message: "删除结果需要人工核对"}); err != nil {
				return DeleteStatus{}, err
			}
			return e.deleteStatus(ctx, m)
		}
		if processed >= deleteBatch {
			break
		}
		if err = ctx.Err(); err != nil {
			return DeleteStatus{}, err
		}
		if err = e.deleteOne(ctx, r, m, item, ancestors); err != nil {
			return DeleteStatus{}, err
		}
		var resultState string
		if err = e.db.QueryRowContext(ctx, `SELECT state FROM delete_items WHERE operation_id=? AND seq=?`, id, item.seq).Scan(&resultState); err != nil {
			return DeleteStatus{}, err
		}
		if resultState == "uncertain" {
			if err = e.mutationState(ctx, &m, "uncertain", &Error{Code: "RESULT_UNCERTAIN", Message: "删除结果需要人工核对"}); err != nil {
				return DeleteStatus{}, err
			}
			return e.deleteStatus(ctx, m)
		}
		processed++
	}
	status, err := e.deleteStatus(ctx, m)
	if err != nil {
		return DeleteStatus{}, err
	}
	if status.Uncertain > 0 {
		err = e.mutationState(ctx, &m, "uncertain", &Error{Code: "RESULT_UNCERTAIN", Message: "删除结果需要人工核对"})
	} else if status.Pending == 0 {
		if status.Skipped > 0 {
			err = e.mutationState(ctx, &m, "partial", nil)
		} else {
			err = e.mutationState(ctx, &m, "committed", nil)
		}
	}
	if err != nil {
		return DeleteStatus{}, err
	}
	return e.deleteStatus(ctx, m)
}

func (e *Engine) DeleteStatus(ctx context.Context, workspace string, revision int64, id string) (DeleteStatus, error) {
	if !validID(id) {
		return DeleteStatus{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err != nil {
		return DeleteStatus{}, err
	}
	if m.WorkspaceID != workspace || m.Revision != revision || m.Kind != "entry.delete" {
		return DeleteStatus{}, fail("OPERATION_SCOPE", "删除操作不属于当前工作区")
	}
	return e.deleteStatus(ctx, m)
}
func (e *Engine) deleteStatus(ctx context.Context, m mutationRecord) (DeleteStatus, error) {
	if m.Error != nil && m.Error.Code == "RESULT_EXPIRED" {
		return DeleteStatus{}, fail("OPERATION_EXPIRED", "删除结果详情已过期，请检查当前文件")
	}
	status := DeleteStatus{DeletePreview: deletePreview(m)}
	err := e.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(state='deleted'),0),COALESCE(SUM(state='skipped'),0),COALESCE(SUM(state IN ('pending','moving','removing')),0),COALESCE(SUM(state='uncertain'),0) FROM delete_items WHERE operation_id=?`, m.ID).Scan(&status.Deleted, &status.Skipped, &status.Pending, &status.Uncertain)
	return status, err
}

// DeleteOutcomes is paginated so callers can inspect every affected path
// without returning the entire recursive manifest in one control frame.
func (e *Engine) DeleteOutcomes(ctx context.Context, workspace string, revision int64, id string, offset, limit int) ([]DeleteOutcome, int, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	return e.deleteOutcomes(ctx, workspace, revision, id, offset, limit)
}

func (e *Engine) deleteOutcomes(ctx context.Context, workspace string, revision int64, id string, offset, limit int) ([]DeleteOutcome, int, error) {
	if offset < 0 || limit < 1 || limit > 64 {
		return nil, 0, fail("INVALID_RANGE", "删除结果分页无效")
	}
	m, err := e.mutation(ctx, id)
	if err != nil {
		return nil, 0, err
	}
	if m.WorkspaceID != workspace || m.Revision != revision || m.Kind != "entry.delete" {
		return nil, 0, fail("OPERATION_SCOPE", "删除操作不属于当前工作区")
	}
	if m.Error != nil && m.Error.Code == "RESULT_EXPIRED" {
		return nil, 0, fail("OPERATION_EXPIRED", "删除结果详情已过期，请检查当前文件")
	}
	rows, err := e.db.QueryContext(ctx, `SELECT path,kind,state,error_code,error_message FROM delete_items WHERE operation_id=? AND seq>=? ORDER BY seq LIMIT ?`, id, offset, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	result := make([]DeleteOutcome, 0)
	used := 0
	for rows.Next() {
		var item DeleteOutcome
		var code, message string
		if err = rows.Scan(&item.Path, &item.Kind, &item.State, &code, &message); err != nil {
			return nil, 0, err
		}
		if code != "" {
			item.Error = &Error{Code: code, Message: message}
		}
		size := 6*len(item.Path) + len(item.Kind) + len(item.State) + len(code) + 6*len(message) + 256
		if used+size > 16*1024 && len(result) > 0 {
			break
		}
		used += size
		result = append(result, item)
	}
	return result, offset + len(result), rows.Err()
}

func (e *Engine) loadDeleteItems(ctx context.Context, id string) ([]storedDeleteItem, error) {
	rows, err := e.db.QueryContext(ctx, `SELECT seq,path,identity,kind,state FROM delete_items WHERE operation_id=? ORDER BY seq`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []storedDeleteItem
	for rows.Next() {
		var item storedDeleteItem
		var raw string
		if err = rows.Scan(&item.seq, &item.name, &raw, &item.kind, &item.state); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &item.ident); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (e *Engine) deleteItemState(ctx context.Context, id string, seq int, state string, reason *Error) error {
	code, message := "", ""
	if reason != nil {
		code, message = reason.Code, reason.Message
	}
	_, err := e.db.ExecContext(ctx, `UPDATE delete_items SET state=?,error_code=?,error_message=? WHERE operation_id=? AND seq=?`, state, code, message, id, seq)
	return err
}
func deleteSameInode(info os.FileInfo, item storedDeleteItem) bool {
	if info == nil {
		return false
	}
	id := identity(info)
	return id.Device == item.ident.Device && id.Inode == item.ident.Inode && id.Mode == item.ident.Mode && (item.kind == "directory" || id.Size == item.ident.Size && id.Mtime == item.ident.Mtime && id.UID == item.ident.UID && id.GID == item.ident.GID && id.Links == item.ident.Links)
}
func checkDeleteParents(r *workspaceHandle, m mutationRecord, item storedDeleteItem, ancestors map[string]fileIdentity) error {
	if err := checkDeleteAnchors(r, m.plan.Anchors, m.plan.MountID); err != nil {
		return err
	}
	parent := path.Dir(item.name)
	for parent != "." && (parent == m.plan.Path || strings.HasPrefix(parent, m.plan.Path+"/")) {
		want, ok := ancestors[parent]
		if !ok {
			return fail("INVALID_STATE", "删除清单缺少父目录身份")
		}
		info, err := r.root.Lstat(parent)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail("FILE_CHANGED", "删除路径的父目录已改变")
		}
		got := identity(info)
		if got.Device != want.Device || got.Inode != want.Inode || got.Mode != want.Mode {
			return fail("FILE_CHANGED", "删除路径的父目录已改变")
		}
		mount, err := deleteMountID(r.root, parent, got)
		if err != nil {
			return err
		}
		if mount != m.plan.MountID {
			return fail("MOUNT_BOUNDARY", "删除路径跨越挂载点")
		}
		parent = path.Dir(parent)
	}
	return nil
}
func directoryEmpty(root *os.Root, name string, expected storedDeleteItem) (bool, error) {
	f, err := root.OpenFile(name, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
	if err != nil {
		return false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !deleteSameInode(info, expected) {
		return false, fail("FILE_CHANGED", "目录身份已改变")
	}
	items, err := f.ReadDir(1)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	return len(items) == 0, nil
}

func (e *Engine) deleteOne(ctx context.Context, r *workspaceHandle, m mutationRecord, item storedDeleteItem, ancestors map[string]fileIdentity) error {
	stage := path.Join(path.Dir(item.name), fmt.Sprintf(".workdeck-delete-%s-%d", m.ID, item.seq))
	skip := func(code, message string) error {
		return e.deleteItemState(ctx, m.ID, item.seq, "skipped", &Error{Code: code, Message: message})
	}
	uncertain := func(message string) error {
		return e.deleteItemState(ctx, m.ID, item.seq, "uncertain", &Error{Code: "RESULT_UNCERTAIN", Message: message + "；请检查工作区内暂存路径 " + stage})
	}
	if err := checkDeleteParents(r, m, item, ancestors); err != nil {
		if item.state != "pending" {
			return uncertain("父目录已改变，暂存结果无法确认")
		}
		return skip("FILE_CHANGED", "父目录已改变，跳过此项")
	}
	if item.state == "pending" {
		info, err := r.root.Lstat(item.name)
		if err != nil || !deleteSameInode(info, item) || item.kind != "directory" && identity(info) != item.ident {
			return skip("FILE_CHANGED", "原对象已改变或不存在")
		}
		mount, err := deleteMountID(r.root, item.name, identity(info))
		if err != nil || mount != m.plan.MountID {
			return skip("MOUNT_BOUNDARY", "对象挂载身份已改变")
		}
		if item.kind == "directory" {
			empty, err := directoryEmpty(r.root, item.name, item)
			if err != nil || !empty {
				return skip("DIRECTORY_NOT_EMPTY", "目录包含未确认或未删除的内容")
			}
		}
		if _, err = r.root.Lstat(stage); !errors.Is(err, os.ErrNotExist) {
			return skip("STAGING_CONFLICT", "暂存路径不可用")
		}
		if err = e.deleteItemState(ctx, m.ID, item.seq, "moving", nil); err != nil {
			return err
		}
		item.state = "moving"
	}
	parent, err := r.root.Open(path.Dir(item.name))
	if err != nil {
		return uncertain("无法打开父目录，请检查暂存文件")
	}
	defer parent.Close()
	opened, err1 := parent.Stat()
	current, err2 := r.root.Stat(path.Dir(item.name))
	if err1 != nil || err2 != nil || identity(opened).Device != identity(current).Device || identity(opened).Inode != identity(current).Inode {
		return uncertain("父目录已改变，请检查暂存文件")
	}
	staged, stageErr := r.root.Lstat(stage)
	if item.state == "moving" && errors.Is(stageErr, os.ErrNotExist) {
		info, sourceErr := r.root.Lstat(item.name)
		if sourceErr != nil || !deleteSameInode(info, item) || item.kind != "directory" && identity(info) != item.ident {
			return uncertain("原对象或暂存对象已改变")
		}
		mount, err := deleteMountID(r.root, item.name, identity(info))
		if err != nil || mount != m.plan.MountID {
			return uncertain("对象挂载身份已改变")
		}
		if item.kind == "directory" {
			empty, err := directoryEmpty(r.root, item.name, item)
			if err != nil || !empty {
				return skip("DIRECTORY_NOT_EMPTY", "目录包含未确认或未删除的内容")
			}
		}
		var leaf unix.Stat_t
		if err = unix.Fstatat(int(parent.Fd()), path.Base(item.name), &leaf, unix.AT_SYMLINK_NOFOLLOW); err != nil || uint64(leaf.Dev) != item.ident.Device || leaf.Ino != item.ident.Inode || item.kind != "directory" && (leaf.Size != item.ident.Size || uint64(leaf.Nlink) != item.ident.Links || leaf.Uid != item.ident.UID || leaf.Gid != item.ident.GID || leaf.Mtim.Sec*1e9+leaf.Mtim.Nsec != item.ident.Mtime || leaf.Ctim.Sec*1e9+leaf.Ctim.Nsec != item.ident.Ctime) {
			return uncertain("原对象在删除前发生变化")
		}
		if err = unix.Renameat2(int(parent.Fd()), path.Base(item.name), int(parent.Fd()), path.Base(stage), unix.RENAME_NOREPLACE); err != nil {
			if errors.Is(err, unix.EEXIST) {
				return skip("STAGING_CONFLICT", "暂存路径已被占用")
			}
			return uncertain("无法确认对象是否已移动到暂存位置")
		}
		if err = parent.Sync(); err != nil {
			return uncertain("暂存移动后磁盘同步未确认")
		}
		if e.afterDeleteMove != nil {
			if err = e.afterDeleteMove(item.name, stage); err != nil {
				return err
			}
		}
		staged, stageErr = r.root.Lstat(stage)
	}
	if errors.Is(stageErr, os.ErrNotExist) && item.state == "removing" {
		return uncertain("暂存对象已消失，删除结果需要核对")
	}
	if stageErr != nil {
		return uncertain("暂存对象已改变，请人工核对")
	}
	if !deleteSameInode(staged, item) {
		if err = unix.Renameat2(int(parent.Fd()), path.Base(stage), int(parent.Fd()), path.Base(item.name), unix.RENAME_NOREPLACE); err != nil {
			return uncertain("暂存对象已改变且无法恢复，请人工核对")
		}
		if err = parent.Sync(); err != nil {
			return uncertain("对象已恢复，但磁盘同步未确认")
		}
		return skip("FILE_CHANGED", "对象在删除前发生变化，已恢复")
	}
	if item.kind == "directory" {
		empty, err := directoryEmpty(r.root, stage, item)
		if err != nil || !empty {
			// A newly arrived entry must remain visible, never be recursively
			// removed by replaying the original manifest.
			if err = unix.Renameat2(int(parent.Fd()), path.Base(stage), int(parent.Fd()), path.Base(item.name), unix.RENAME_NOREPLACE); err != nil {
				return uncertain("目录有新增内容，暂存目录无法自动恢复")
			}
			if err = parent.Sync(); err != nil {
				return uncertain("目录已恢复，但磁盘同步未确认")
			}
			return skip("DIRECTORY_NOT_EMPTY", "目录出现未确认的内容")
		}
	}
	if item.state != "removing" {
		if err = e.deleteItemState(ctx, m.ID, item.seq, "removing", nil); err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	verified, err := r.root.Lstat(stage)
	if err != nil || !deleteSameInode(verified, item) {
		return uncertain("暂存对象在删除前发生变化")
	}
	mount, err := deleteMountID(r.root, stage, identity(verified))
	if err != nil || mount != m.plan.MountID {
		return uncertain("暂存对象挂载身份已改变")
	}
	if err = checkDeleteParents(r, m, item, ancestors); err != nil {
		return uncertain("父目录在删除前发生变化")
	}
	flags := 0
	if item.kind == "directory" {
		flags = unix.AT_REMOVEDIR
	}
	if err = unix.Unlinkat(int(parent.Fd()), path.Base(stage), flags); err != nil {
		if item.kind == "directory" && (errors.Is(err, unix.ENOTEMPTY) || errors.Is(err, unix.EEXIST)) {
			if restore := unix.Renameat2(int(parent.Fd()), path.Base(stage), int(parent.Fd()), path.Base(item.name), unix.RENAME_NOREPLACE); restore != nil {
				return uncertain("目录出现新内容且无法恢复，请人工核对")
			}
			if syncErr := parent.Sync(); syncErr != nil {
				return uncertain("目录已恢复，但磁盘同步未确认")
			}
			return skip("DIRECTORY_NOT_EMPTY", "目录出现未确认的内容")
		}
		return uncertain("暂存对象未能删除，请人工核对")
	}
	if e.afterDeleteRemove != nil {
		if err = e.afterDeleteRemove(item.name, stage); err != nil {
			return err
		}
	}
	if err = parent.Sync(); err != nil {
		return uncertain("对象已删除，但磁盘同步未确认")
	}
	return e.deleteItemState(ctx, m.ID, item.seq, "deleted", nil)
}
