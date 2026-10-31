package files

import (
	"context"
	"encoding/json"
)

// PendingWrite describes durable reservations, including uncertain commits.
// Listing is scoped to the authenticated workspace revision and never changes a file.
type PendingWrite struct {
	Operation
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Create    bool   `json:"create"`
	UpdatedAt int64  `json:"updated_at"`
}

type PendingWritePage struct {
	Items   []PendingWrite `json:"items"`
	Next    int            `json:"next"`
	HasMore bool           `json:"has_more"`
}

func (e *Engine) PendingWrites(ctx context.Context, workspace string, revision int64, offset int) (PendingWritePage, error) {
	result := PendingWritePage{Items: []PendingWrite{}, Next: offset}
	if offset < 0 || offset > 16 {
		return result, fail("INVALID_RANGE", "待处理写入分页无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	if err := e.checkPendingScope(ctx, workspace, revision); err != nil {
		return result, err
	}
	rows, err := e.db.QueryContext(ctx, `SELECT id,state,offset,spec,updated_at FROM operations WHERE workspace_id=? AND revision=? AND kind='write' AND state IN ('receiving','ready','committing','uncertain') ORDER BY created_at,id LIMIT 2 OFFSET ?`, workspace, revision, offset)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(result.Items) == 1 {
			result.HasMore = true
			break
		}
		var item PendingWrite
		var raw string
		if err = rows.Scan(&item.ID, &item.State, &item.Offset, &raw, &item.UpdatedAt); err != nil {
			return result, err
		}
		var plan writePlan
		if err = json.Unmarshal([]byte(raw), &plan); err != nil {
			return result, err
		}
		if !validID(item.ID) || validPath(plan.Path, false) != nil || plan.Size < 0 || item.Offset < 0 || item.Offset > plan.Size || item.UpdatedAt < 1 {
			return result, fail("INVALID_STATE", "待处理写入记录无效")
		}
		item.WorkspaceID, item.Revision, item.Kind = workspace, revision, "write"
		item.Path, item.Size, item.Create = plan.Path, plan.Size, plan.Create
		result.Items = append(result.Items, item)
		result.Next++
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	return result, nil
}

func (e *Engine) checkPendingScope(ctx context.Context, workspace string, revision int64) error {
	w, err := e.workspaceRecord(ctx, workspace)
	if err != nil {
		return err
	}
	if w.Revision != revision {
		return fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	return nil
}

// CancelPendingWrite rejects an outdated inspection and only aborts a write
// that has not entered commit. It never removes or rewrites the target file.
func (e *Engine) CancelPendingWrite(ctx context.Context, workspace string, revision int64, id, state string, offset, updatedAt int64) (Operation, error) {
	if !validID(id) || (state != "receiving" && state != "ready") || offset < 0 || updatedAt < 1 {
		return Operation{}, fail("INVALID_REQUEST", "待处理写入参数无效")
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
	var current int64
	if err = e.db.QueryRowContext(ctx, `SELECT updated_at FROM operations WHERE id=?`, id).Scan(&current); err != nil {
		return rec.Operation, err
	}
	if rec.State != state || rec.Offset != offset || current != updatedAt {
		return rec.Operation, fail("PRECONDITION_CHANGED", "操作状态已变化，请重新核对")
	}
	if err = e.checkPendingScope(ctx, workspace, revision); err != nil {
		return rec.Operation, err
	}
	r, release, err := e.acquire(ctx, workspace, revision)
	if err != nil && ErrorCode(err) != "ROOT_UNAVAILABLE" && ErrorCode(err) != "ROOT_REPLACED" {
		return rec.Operation, err
	}
	if err == nil {
		defer release()
	}
	if err = e.storeState(ctx, &rec, "aborted", rec.Offset, "", nil); err != nil {
		return rec.Operation, err
	}
	if r != nil {
		e.removeTemporary(r, rec)
	}
	return rec.Operation, nil
}
