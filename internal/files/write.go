package files

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

type writePlan struct {
	WriteSpec
	Original *fileIdentity `json:"original,omitempty"`
}

type operationRecord struct {
	Operation
	fingerprint     string
	plan            writePlan
	temporary       string
	temporaryDevice uint64
	temporaryInode  uint64
}

const operationColumns = `id,workspace_id,revision,kind,fingerprint,state,offset,version,spec,temp_path,temp_device,temp_inode,error_code,error_message`

func (e *Engine) loadOperation(ctx context.Context, id string) (operationRecord, error) {
	var rec operationRecord
	var data, device, inode, code, message string
	err := e.db.QueryRowContext(ctx, `SELECT `+operationColumns+` FROM operations WHERE id=?`, id).Scan(
		&rec.ID, &rec.WorkspaceID, &rec.Revision, &rec.Kind, &rec.fingerprint, &rec.State, &rec.Offset, &rec.Version, &data, &rec.temporary, &device, &inode, &code, &message)
	if errors.Is(err, sql.ErrNoRows) {
		return rec, fail("OPERATION_NOT_FOUND", "操作记录不存在或已过期")
	}
	if err != nil {
		return rec, err
	}
	if err = json.Unmarshal([]byte(data), &rec.plan); err != nil {
		return rec, err
	}
	if device != "" {
		rec.temporaryDevice, err = strconv.ParseUint(device, 10, 64)
		if err != nil {
			return rec, err
		}
	}
	if inode != "" {
		rec.temporaryInode, err = strconv.ParseUint(inode, 10, 64)
		if err != nil {
			return rec, err
		}
	}
	if code != "" {
		rec.Error = &Error{code, message}
	}
	return rec, nil
}

func binding(rec operationRecord, workspace string, revision int64) error {
	if rec.WorkspaceID != workspace || rec.Revision != revision {
		return fail("OPERATION_SCOPE", "操作不属于当前工作区修订")
	}
	return nil
}

func (e *Engine) storeState(ctx context.Context, rec *operationRecord, state string, offset int64, version string, reason *Error) error {
	code, message := "", ""
	if reason != nil {
		code, message = reason.Code, reason.Message
	}
	_, err := e.db.ExecContext(ctx, `UPDATE operations SET state=?,offset=?,version=?,error_code=?,error_message=?,updated_at=? WHERE id=?`, state, offset, version, code, message, e.now().UnixMilli(), rec.ID)
	if err == nil {
		rec.State, rec.Offset, rec.Version, rec.Error = state, offset, version, reason
	}
	return err
}

func (e *Engine) BeginWrite(ctx context.Context, workspace string, revision int64, id string, spec WriteSpec) (Operation, error) {
	if !validID(id) {
		return Operation{}, fail("INVALID_ID", "操作标识无效")
	}
	if err := validPath(spec.Path, false); err != nil {
		return Operation{}, err
	}
	digest, err := hex.DecodeString(spec.SHA256)
	if err != nil || len(digest) != 32 || spec.SHA256 != strings.ToLower(spec.SHA256) {
		return Operation{}, fail("INVALID_DIGEST", "文件摘要无效")
	}
	if spec.Size < 0 || spec.Size > e.maxUpload {
		return Operation{}, fail("FILE_TOO_LARGE", "文件超出上传大小限制")
	}
	if spec.Create && spec.BaseVersion != "" || !spec.Create && spec.BaseVersion == "" {
		return Operation{}, fail("INVALID_VERSION", "保存必须指定打开时的版本，新建不得覆盖已有文件")
	}
	fingerprint := fingerprint(struct {
		Workspace string
		Revision  int64
		Spec      WriteSpec
	}{workspace, revision, spec})
	e.commit.Lock()
	defer e.commit.Unlock()
	previous, err := e.loadOperation(ctx, id)
	if err == nil {
		if previous.fingerprint != fingerprint || binding(previous, workspace, revision) != nil {
			return Operation{}, fail("ID_REUSED", "操作标识不能用于不同内容")
		}
		return previous.Operation, nil
	}
	if ErrorCode(err) != "OPERATION_NOT_FOUND" {
		return Operation{}, err
	}
	var conflictingID int
	if err := e.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM root_changes WHERE id=?) + (SELECT count(*) FROM mutations WHERE id=?)`, id, id).Scan(&conflictingID); err != nil {
		return Operation{}, err
	}
	if conflictingID != 0 {
		return Operation{}, fail("ID_REUSED", "操作标识不能用于不同内容")
	}
	if !freshID(id, e.now()) {
		return Operation{}, fail("OPERATION_EXPIRED", "操作标识已过期，请重新核对文件后保存")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return Operation{}, err
	}
	defer release()
	plan := writePlan{WriteSpec: spec}
	if spec.Create {
		if _, err = r.root.Lstat(spec.Path); err == nil {
			return Operation{}, fail("ALREADY_EXISTS", "目标已存在，请另取文件名")
		}
		if !errors.Is(err, os.ErrNotExist) {
			return Operation{}, fail("FILE_UNAVAILABLE", "无法检查新文件目标")
		}
	} else {
		current, err := e.openWritableBase(ctx, workspace, revision, spec.Path)
		if err != nil {
			return Operation{}, err
		}
		original := current.original
		version := current.Metadata.Version
		current.Close()
		if version != spec.BaseVersion {
			return Operation{}, fail("CONFLICT", "文件已被其他程序修改，请先比较差异")
		}
		plan.Original = &original
	}
	// Count durable reservations, not just currently connected browser streams.
	rows, err := e.db.QueryContext(ctx, `SELECT spec FROM operations WHERE state IN ('receiving','ready','committing','uncertain')`)
	if err != nil {
		return Operation{}, err
	}
	count := 0
	var reserved int64
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			break
		}
		var p writePlan
		if err = json.Unmarshal([]byte(raw), &p); err != nil {
			break
		}
		reserved += p.Size
		count++
	}
	readErr := rows.Err()
	rows.Close()
	if err != nil {
		return Operation{}, err
	}
	if readErr != nil {
		return Operation{}, readErr
	}
	if count >= 16 || reserved+spec.Size > 2<<30 {
		return Operation{}, fail("QUOTA_EXCEEDED", "未完成上传过多，请先完成或取消已有操作")
	}
	temporary := path.Join(path.Dir(spec.Path), ".workdeck-write-"+id)
	f, err := r.root.OpenFile(temporary, os.O_RDWR|os.O_CREATE|os.O_EXCL|unix.O_NONBLOCK, 0600)
	if err != nil {
		return Operation{}, fail("TEMP_CREATE_FAILED", "无法在目标目录创建临时文件，请检查权限和存储空间")
	}
	info, err := f.Stat()
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		if info != nil {
			ident := identity(info)
			e.removeTemporary(r, operationRecord{temporary: temporary, temporaryDevice: ident.Device, temporaryInode: ident.Inode})
		}
		return Operation{}, err
	}
	ident := identity(info)
	rec := operationRecord{Operation: Operation{ID: id, WorkspaceID: workspace, Revision: revision, Kind: "write", State: "receiving"}, fingerprint: fingerprint, plan: plan, temporary: temporary, temporaryDevice: ident.Device, temporaryInode: ident.Inode}
	if spec.Size == 0 {
		empty, _ := digestReader(bytes.NewReader(nil))
		if empty != spec.SHA256 {
			e.removeTemporary(r, rec)
			return Operation{}, fail("HASH_MISMATCH", "文件内容与摘要不一致")
		}
		rec.State = "ready"
	}
	data, _ := json.Marshal(plan)
	_, err = e.db.ExecContext(ctx, `INSERT INTO operations (`+operationColumns+`,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		rec.ID, workspace, revision, "write", fingerprint, rec.State, 0, "", string(data), temporary, strconv.FormatUint(ident.Device, 10), strconv.FormatUint(ident.Inode, 10), "", "", e.now().UnixMilli(), e.now().UnixMilli())
	if err != nil {
		e.removeTemporary(r, rec)
		return Operation{}, err
	}
	return rec.Operation, nil
}

func (e *Engine) openWritableBase(ctx context.Context, workspace string, revision int64, name string) (*Reader, error) {
	reader, err := e.OpenRead(ctx, workspace, revision, name, "")
	if err != nil {
		return nil, err
	}
	if reader.Metadata.Restricted || reader.original.Links != 1 || os.FileMode(reader.original.Mode)&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		reader.Close()
		return nil, fail("UNSUPPORTED_METADATA", "此文件包含链接或特殊权限，请选择实际文件或另存")
	}
	n, err := unix.Flistxattr(int(reader.file.Fd()), nil)
	if err != nil && !errors.Is(err, syscall.ENOTSUP) {
		reader.Close()
		return nil, err
	}
	if n > 0 {
		reader.Close()
		return nil, fail("UNSUPPORTED_METADATA", "此文件包含扩展属性，请另存以避免丢失属性")
	}
	return reader, nil
}

func (e *Engine) openTemporary(r *workspaceHandle, rec operationRecord) (*os.File, error) {
	leaf, err := r.root.Lstat(rec.temporary)
	if err != nil || !leaf.Mode().IsRegular() {
		return nil, fail("TEMP_CHANGED", "上传临时文件已改变")
	}
	f, err := r.root.OpenFile(rec.temporary, os.O_RDWR|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, fail("TEMP_CHANGED", "上传临时文件不可访问")
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	ident := identity(info)
	if !info.Mode().IsRegular() || ident.Device != rec.temporaryDevice || ident.Inode != rec.temporaryInode || ident.Links != 1 {
		f.Close()
		return nil, fail("TEMP_CHANGED", "上传临时文件身份已改变")
	}
	return f, nil
}
func (e *Engine) removeTemporary(r *workspaceHandle, rec operationRecord) {
	info, err := r.root.Lstat(rec.temporary)
	if err != nil {
		return
	}
	ident := identity(info)
	if ident.Device == rec.temporaryDevice && ident.Inode == rec.temporaryInode && info.Mode().IsRegular() {
		_ = r.root.Remove(rec.temporary)
	}
}

func (e *Engine) Append(ctx context.Context, workspace string, revision int64, id string, offset int64, data []byte) (Operation, error) {
	if len(data) > ChunkLimit || offset < 0 {
		return Operation{}, fail("INVALID_RANGE", "数据块范围无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	rec, err := e.loadOperation(ctx, id)
	if err != nil {
		return Operation{}, err
	}
	if err = binding(rec, workspace, revision); err != nil {
		return Operation{}, err
	}
	if rec.State != "receiving" && rec.State != "ready" {
		return rec.Operation, fail("INVALID_STATE", "此操作已不再接收数据")
	}
	if offset > rec.plan.Size || int64(len(data)) > rec.plan.Size-offset {
		return rec.Operation, fail("INVALID_RANGE", "数据块超过声明的文件长度")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return rec.Operation, err
	}
	defer release()
	f, err := e.openTemporary(r, rec)
	if err != nil {
		return rec.Operation, err
	}
	defer f.Close()
	if offset < rec.Offset {
		if int64(len(data)) > rec.Offset-offset {
			return rec.Operation, fail("INVALID_OFFSET", "重复数据块与已确认范围重叠")
		}
		previous := make([]byte, len(data))
		if _, err = f.ReadAt(previous, offset); err != nil {
			return rec.Operation, err
		}
		if !bytes.Equal(previous, data) {
			return rec.Operation, fail("CHUNK_MISMATCH", "重复数据块内容不一致")
		}
		return rec.Operation, nil
	}
	if offset != rec.Offset {
		return rec.Operation, fail("INVALID_OFFSET", "请从节点已确认的偏移继续上传")
	}
	if err = ctx.Err(); err != nil {
		return rec.Operation, err
	}
	if n, err := f.WriteAt(data, offset); err != nil {
		return rec.Operation, err
	} else if n != len(data) {
		return rec.Operation, io.ErrShortWrite
	}
	if err = f.Sync(); err != nil {
		return rec.Operation, err
	}
	next := offset + int64(len(data))
	state := "receiving"
	if next == rec.plan.Size {
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			return rec.Operation, err
		}
		digest, err := digestReader(contextReader{ctx, f})
		if err != nil {
			return rec.Operation, err
		}
		if digest != rec.plan.SHA256 {
			reason := &Error{"HASH_MISMATCH", "文件内容与摘要不一致，请重新上传"}
			if err = e.storeState(ctx, &rec, "aborted", rec.Offset, "", reason); err != nil {
				return rec.Operation, err
			}
			e.removeTemporary(r, rec)
			return rec.Operation, reason
		}
		state = "ready"
	}
	err = e.storeState(ctx, &rec, state, next, "", nil)
	return rec.Operation, err
}

func (e *Engine) Status(ctx context.Context, workspace string, revision int64, id string) (Operation, error) {
	if !validID(id) {
		return Operation{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	rec, err := e.loadOperation(ctx, id)
	if err != nil {
		return Operation{}, err
	}
	if err = binding(rec, workspace, revision); err != nil {
		return Operation{}, err
	}
	if rec.State == "committing" || rec.State == "uncertain" {
		r, release, err := e.acquire(ctx, workspace, revision)
		if err != nil {
			return rec.Operation, err
		}
		defer release()
		return e.recoverCommit(ctx, r, &rec)
	}
	return rec.Operation, nil
}

func (e *Engine) Abort(ctx context.Context, workspace string, revision int64, id string) (Operation, error) {
	e.commit.Lock()
	defer e.commit.Unlock()
	rec, err := e.loadOperation(ctx, id)
	if err != nil {
		return Operation{}, err
	}
	if err = binding(rec, workspace, revision); err != nil {
		return Operation{}, err
	}
	if rec.State == "committed" || rec.State == "aborted" {
		return rec.Operation, nil
	}
	if rec.State == "committing" || rec.State == "uncertain" {
		return rec.Operation, fail("RESULT_UNCERTAIN", "请先确认操作结果，不能取消已开始的提交")
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil {
		return rec.Operation, err
	}
	defer release()
	if err = e.storeState(ctx, &rec, "aborted", rec.Offset, "", nil); err != nil {
		return rec.Operation, err
	}
	e.removeTemporary(r, rec)
	return rec.Operation, nil
}
