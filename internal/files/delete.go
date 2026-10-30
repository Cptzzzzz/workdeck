package files

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
)

const maxDeleteItems = 8192
const maxDeleteDepth = 64
const maxDeletePathBytes = 8 << 20
const maxDeleteJournalItems = 131072

type DeletePreview struct {
	Operation
	Path        string `json:"path"`
	Recursive   bool   `json:"recursive"`
	Count       int    `json:"count"`
	Directories int    `json:"directories"`
	Bytes       int64  `json:"bytes"`
}
type deleteItem struct {
	name     string
	identity fileIdentity
	kind     string
}
type deleteAnchor struct {
	Path     string       `json:"path"`
	Identity fileIdentity `json:"identity"`
}

// PrepareDelete records an immutable, bounded post-order snapshot without
// changing any workspace entries. Execution requires a separate confirmation.
func (e *Engine) PrepareDelete(ctx context.Context, workspace string, revision int64, id, name, version string, recursive bool) (DeletePreview, error) {
	if !validID(id) {
		return DeletePreview{}, fail("INVALID_ID", "操作标识无效")
	}
	if err := validPath(name, false); err != nil {
		return DeletePreview{}, err
	}
	if version == "" {
		return DeletePreview{}, fail("INVALID_VERSION", "删除前必须确认文件版本")
	}
	fp := fingerprint(struct {
		Workspace           string
		Revision            int64
		Kind, Path, Version string
		Recursive           bool
	}{workspace, revision, "entry.delete", name, version, recursive})
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err == nil {
		if m.WorkspaceID != workspace || m.Revision != revision || m.fingerprint != fp {
			return DeletePreview{}, fail("ID_REUSED", "操作标识不能用于不同内容")
		}
		return deletePreview(m), nil
	}
	if ErrorCode(err) != "OPERATION_NOT_FOUND" {
		return DeletePreview{}, err
	}
	var occupied int
	if err = e.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM operations WHERE id=?) + (SELECT count(*) FROM root_changes WHERE id=?)`, id, id).Scan(&occupied); err != nil {
		return DeletePreview{}, err
	}
	if occupied != 0 {
		return DeletePreview{}, fail("ID_REUSED", "操作标识不能用于不同内容")
	}
	if !freshID(id, e.now()) {
		return DeletePreview{}, fail("OPERATION_EXPIRED", "操作标识已过期，请重新确认")
	}
	var pending int
	if err = e.db.QueryRowContext(ctx, `SELECT count(*) FROM mutations WHERE state IN ('prepared','uncertain','deleting')`).Scan(&pending); err != nil {
		return DeletePreview{}, err
	}
	if pending >= 64 {
		return DeletePreview{}, fail("QUOTA_EXCEEDED", "待确认的文件操作过多")
	}
	meta, err := e.Stat(ctx, workspace, revision, name)
	if err != nil {
		return DeletePreview{}, err
	}
	if meta.Restricted || (meta.Kind != "file" && meta.Kind != "directory") {
		return DeletePreview{}, fail("SPECIAL_FILE", "不能删除此文件类型")
	}
	if meta.Version != version {
		return DeletePreview{}, fail("FILE_CHANGED", "文件已改变，请刷新后重新确认")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return DeletePreview{}, err
	}
	defer release()
	info, err := r.root.Lstat(name)
	if err != nil {
		return DeletePreview{}, fail("FILE_CHANGED", "文件已改变")
	}
	original := identity(info)
	if versionFor(original, meta.SHA256) != version {
		return DeletePreview{}, fail("FILE_CHANGED", "文件已改变，请刷新后重新确认")
	}
	rootInfo, err := r.root.Stat(".")
	if err != nil {
		return DeletePreview{}, fail("ROOT_UNAVAILABLE", "无法确认工作区挂载身份")
	}
	rootMount, err := deleteMountID(r.root, ".", identity(rootInfo))
	if err != nil {
		return DeletePreview{}, err
	}
	anchors, err := captureDeleteAnchors(r, name, rootMount)
	if err != nil {
		return DeletePreview{}, err
	}
	items, dirs, bytes, err := snapshotDelete(ctx, r, name, original, recursive, rootMount)
	if err != nil {
		return DeletePreview{}, err
	}
	if err = checkDeleteAnchors(r, anchors, rootMount); err != nil {
		return DeletePreview{}, err
	}
	if err = e.pruneDeleteJournal(ctx); err != nil {
		return DeletePreview{}, err
	}
	var journalItems int
	if err = e.db.QueryRowContext(ctx, `SELECT count(*) FROM delete_items`).Scan(&journalItems); err != nil {
		return DeletePreview{}, err
	}
	if journalItems+len(items) > maxDeleteJournalItems {
		return DeletePreview{}, fail("QUOTA_EXCEEDED", "删除操作记录已达上限，请联系节点管理员处理")
	}
	plan := directoryPlan{Path: name, Device: original.Device, Inode: original.Inode, Original: original, Count: len(items), Dirs: dirs, Bytes: bytes, Recursive: recursive, Anchors: anchors, MountID: rootMount}
	raw, err := json.Marshal(plan)
	if err != nil {
		return DeletePreview{}, err
	}
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return DeletePreview{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO mutations(id,workspace_id,revision,kind,fingerprint,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, workspace, revision, "entry.delete", fp, string(raw), e.now().UnixMilli(), e.now().UnixMilli())
	if err != nil {
		return DeletePreview{}, err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO delete_items(operation_id,seq,path,identity,kind) VALUES(?,?,?,?,?)`)
	if err != nil {
		return DeletePreview{}, err
	}
	for i, item := range items {
		encoded, encodeErr := json.Marshal(item.identity)
		if encodeErr != nil {
			stmt.Close()
			return DeletePreview{}, encodeErr
		}
		if _, err = stmt.ExecContext(ctx, id, i, item.name, string(encoded), item.kind); err != nil {
			stmt.Close()
			return DeletePreview{}, err
		}
	}
	if err = stmt.Close(); err != nil {
		return DeletePreview{}, err
	}
	if err = tx.Commit(); err != nil {
		return DeletePreview{}, err
	}
	m = mutationRecord{Operation: Operation{ID: id, WorkspaceID: workspace, Revision: revision, Kind: "entry.delete", State: "prepared"}, fingerprint: fp, plan: plan}
	return deletePreview(m), nil
}

// Keep completed details for at least ResultLifetime while retaining the
// operation identity indefinitely, so an expired ID can never be replayed.
func (e *Engine) pruneDeleteJournal(ctx context.Context) error {
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	cutoff := e.now().Add(-ResultLifetime).UnixMilli()
	if _, err = tx.ExecContext(ctx, `UPDATE mutations SET error_code='RESULT_EXPIRED',error_message='删除结果详情已过期' WHERE kind='entry.delete' AND state IN ('committed','partial','aborted') AND updated_at<? AND error_code=''`, cutoff); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM delete_items WHERE operation_id IN (SELECT id FROM mutations WHERE kind='entry.delete' AND error_code='RESULT_EXPIRED')`); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteMountID(root *os.Root, name string, expected fileIdentity) (uint64, error) {
	f, err := root.OpenFile(name, unix.O_PATH|unix.O_NOFOLLOW, 0)
	if err != nil {
		return 0, fail("FILE_CHANGED", "无法确认对象挂载身份")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || identity(info).Device != expected.Device || identity(info).Inode != expected.Inode || identity(info).Mode != expected.Mode {
		return 0, fail("FILE_CHANGED", "对象身份已改变")
	}
	var stat unix.Statx_t
	if err = unix.Statx(int(f.Fd()), "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &stat); err != nil || stat.Mask&unix.STATX_MNT_ID == 0 || stat.Mnt_id == 0 {
		return 0, fail("UNSUPPORTED_FILESYSTEM", "系统无法确认挂载边界，不能安全删除")
	}
	return stat.Mnt_id, nil
}

func captureDeleteAnchors(r *workspaceHandle, name string, rootMount uint64) ([]deleteAnchor, error) {
	parent := path.Dir(name)
	if parent == "." {
		return nil, nil
	}
	var result []deleteAnchor
	current := ""
	for _, component := range strings.Split(parent, "/") {
		current = path.Join(current, component)
		info, err := r.root.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fail("DIRECTORY_UNAVAILABLE", "删除路径的父目录不可用或包含链接")
		}
		ident := identity(info)
		if ident.Device != r.spec.Device {
			return nil, fail("MOUNT_BOUNDARY", "删除路径跨越挂载点")
		}
		mount, err := deleteMountID(r.root, current, ident)
		if err != nil {
			return nil, err
		}
		if mount != rootMount {
			return nil, fail("MOUNT_BOUNDARY", "删除路径跨越挂载点")
		}
		result = append(result, deleteAnchor{Path: current, Identity: ident})
	}
	return result, nil
}
func checkDeleteAnchors(r *workspaceHandle, anchors []deleteAnchor, rootMount uint64) error {
	rootInfo, err := r.root.Stat(".")
	if err != nil {
		return fail("ROOT_UNAVAILABLE", "无法确认工作区挂载身份")
	}
	mount, err := deleteMountID(r.root, ".", identity(rootInfo))
	if err != nil {
		return err
	}
	if mount != rootMount {
		return fail("MOUNT_BOUNDARY", "工作区挂载身份已改变")
	}
	for _, anchor := range anchors {
		info, err := r.root.Lstat(anchor.Path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail("FILE_CHANGED", "删除路径的父目录已改变")
		}
		got := identity(info)
		if got.Device != anchor.Identity.Device || got.Inode != anchor.Identity.Inode || got.Mode != anchor.Identity.Mode {
			return fail("FILE_CHANGED", "删除路径的父目录已改变")
		}
		mount, err = deleteMountID(r.root, anchor.Path, got)
		if err != nil {
			return err
		}
		if mount != rootMount {
			return fail("MOUNT_BOUNDARY", "删除路径跨越挂载点")
		}
	}
	return nil
}

func deletePreview(m mutationRecord) DeletePreview {
	return DeletePreview{Operation: m.Operation, Path: m.plan.Path, Recursive: m.plan.Recursive, Count: m.plan.Count, Directories: m.plan.Dirs, Bytes: m.plan.Bytes}
}

func (e *Engine) CancelDelete(ctx context.Context, workspace string, revision int64, id string) (DeletePreview, error) {
	if !validID(id) {
		return DeletePreview{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	m, err := e.mutation(ctx, id)
	if err != nil {
		return DeletePreview{}, err
	}
	if m.WorkspaceID != workspace || m.Revision != revision || m.Kind != "entry.delete" {
		return DeletePreview{}, fail("OPERATION_SCOPE", "删除操作不属于当前工作区")
	}
	if m.State == "prepared" {
		tx, err := e.db.BeginTx(ctx, nil)
		if err != nil {
			return DeletePreview{}, err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `UPDATE delete_items SET state='skipped',error_code='CANCELLED',error_message='用户取消后未执行' WHERE operation_id=? AND state='pending'`, id); err != nil {
			return DeletePreview{}, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE mutations SET state='aborted',updated_at=? WHERE id=?`, e.now().UnixMilli(), id); err != nil {
			return DeletePreview{}, err
		}
		if err = tx.Commit(); err != nil {
			return DeletePreview{}, err
		}
		m.State = "aborted"
	}
	if m.State == "deleting" {
		var intermediate int
		if err = e.db.QueryRowContext(ctx, `SELECT count(*) FROM delete_items WHERE operation_id=? AND state IN ('moving','removing','uncertain')`, id).Scan(&intermediate); err != nil {
			return DeletePreview{}, err
		}
		if intermediate != 0 {
			return deletePreview(m), fail("RESULT_UNCERTAIN", "存在未确认的暂存项，请先核对")
		}
		tx, err := e.db.BeginTx(ctx, nil)
		if err != nil {
			return DeletePreview{}, err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `UPDATE delete_items SET state='skipped',error_code='CANCELLED',error_message='用户取消后未执行' WHERE operation_id=? AND state='pending'`, id); err != nil {
			return DeletePreview{}, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE mutations SET state='partial',updated_at=? WHERE id=?`, e.now().UnixMilli(), id); err != nil {
			return DeletePreview{}, err
		}
		if err = tx.Commit(); err != nil {
			return DeletePreview{}, err
		}
		m.State = "partial"
		return deletePreview(m), nil
	}
	if m.State != "aborted" {
		return deletePreview(m), fail("INVALID_STATE", "已开始的删除不能当作未执行取消")
	}
	return deletePreview(m), nil
}

func snapshotDelete(ctx context.Context, r *workspaceHandle, root string, initial fileIdentity, recursive bool, rootMount uint64) ([]deleteItem, int, int64, error) {
	items := make([]deleteItem, 0)
	dirs := 0
	var bytes int64
	var pathBytes int
	var walk func(string, int, *fileIdentity) error
	walk = func(name string, depth int, expected *fileIdentity) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxDeleteDepth || len(items) >= maxDeleteItems {
			return fail("DELETE_LIMIT", "删除范围超过条目数或目录深度限制")
		}
		encodedPath, err := json.Marshal(name)
		if err != nil || len(encodedPath) > 7000 {
			return fail("DELETE_LIMIT", "路径编码长度超过删除结果限制")
		}
		info, err := r.root.Lstat(name)
		if err != nil {
			return fail("FILE_CHANGED", "删除范围在扫描时发生变化")
		}
		ident := identity(info)
		if expected != nil && ident != *expected {
			return fail("FILE_CHANGED", "删除范围在扫描时发生变化")
		}
		if ident.Device != r.spec.Device {
			return fail("MOUNT_BOUNDARY", "删除范围包含挂载点，请单独处理")
		}
		mount, err := deleteMountID(r.root, name, ident)
		if err != nil {
			return err
		}
		if mount != rootMount {
			return fail("MOUNT_BOUNDARY", "删除范围包含挂载点，请单独处理")
		}
		kind := "file"
		switch {
		case info.IsDir():
			kind = "directory"
		case info.Mode()&os.ModeSymlink != 0:
			kind = "symlink"
		case info.Mode().IsRegular():
			if info.Size() < 0 || bytes > math.MaxInt64-info.Size() {
				return fail("DELETE_LIMIT", "删除范围大小超出限制")
			}
			bytes += info.Size()
		default:
			return fail("SPECIAL_FILE", "删除范围包含特殊文件，请单独处理")
		}
		if kind == "directory" {
			file, err := r.root.OpenFile(name, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
			if err != nil {
				return fail("DIRECTORY_UNAVAILABLE", "无法扫描删除目录")
			}
			opened, err := file.Stat()
			if err != nil || identity(opened) != ident {
				file.Close()
				return fail("FILE_CHANGED", "目录在扫描时发生变化")
			}
			var names []string
			for {
				entries, readErr := file.ReadDir(128)
				for _, child := range entries {
					if len(names)+len(items) >= maxDeleteItems {
						file.Close()
						return fail("DELETE_LIMIT", "删除范围超过条目数限制")
					}
					names = append(names, child.Name())
				}
				if errors.Is(readErr, io.EOF) {
					break
				}
				if readErr != nil {
					file.Close()
					return fail("DIRECTORY_UNAVAILABLE", "无法完整读取删除目录")
				}
			}
			after, err := file.Stat()
			file.Close()
			if err != nil || identity(after) != ident {
				return fail("FILE_CHANGED", "目录在扫描时发生变化")
			}
			if len(names) > 0 && !recursive {
				return fail("DIRECTORY_NOT_EMPTY", "非空目录需要明确确认递归删除")
			}
			sort.Strings(names)
			for _, child := range names {
				next := path.Join(name, child)
				if err := validPath(next, false); err != nil {
					return err
				}
				if err := walk(next, depth+1, nil); err != nil {
					return err
				}
			}
			dirs++
		}
		if len(items) >= maxDeleteItems {
			return fail("DELETE_LIMIT", "删除范围超过条目数限制")
		}
		pathBytes += len(name)
		if pathBytes > maxDeletePathBytes {
			return fail("DELETE_LIMIT", "删除范围路径总长度超过限制")
		}
		items = append(items, deleteItem{name: name, identity: ident, kind: kind})
		return nil
	}
	if err := walk(root, 0, &initial); err != nil {
		return nil, 0, 0, err
	}
	return items, dirs, bytes, nil
}
