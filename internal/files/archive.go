package files

import "context"

// ArchivedOperation is a journal snapshot. Looking it up never replays,
// reconciles or accesses paths in either the previous or current root.
type ArchivedOperation struct {
	Operation
	Path           string        `json:"path"`
	Source         string        `json:"source,omitempty"`
	Write          *WriteSpec    `json:"write,omitempty"`
	Recursive      bool          `json:"recursive,omitempty"`
	Delete         *DeleteStatus `json:"delete,omitempty"`
	DetailsExpired bool          `json:"details_expired,omitempty"`
}

func (e *Engine) checkArchiveScope(ctx context.Context, workspace string, current, previous int64) error {
	if !validID(workspace) || previous < 1 || current <= previous {
		return fail("OPERATION_SCOPE", "旧工作区修订无效")
	}
	w, err := e.workspaceRecord(ctx, workspace)
	if err != nil {
		return err
	}
	if w.Revision != current {
		return fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	return nil
}

func (e *Engine) ArchivedOperationStatus(ctx context.Context, workspace string, current, previous int64, id string) (ArchivedOperation, error) {
	if !validID(id) {
		return ArchivedOperation{}, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	if err := e.checkArchiveScope(ctx, workspace, current, previous); err != nil {
		return ArchivedOperation{}, err
	}
	rec, err := e.loadOperation(ctx, id)
	if err == nil {
		if err = binding(rec, workspace, previous); err != nil {
			return ArchivedOperation{}, err
		}
		spec := rec.plan.WriteSpec
		return ArchivedOperation{Operation: rec.Operation, Path: spec.Path, Write: &spec}, nil
	}
	if ErrorCode(err) != "OPERATION_NOT_FOUND" {
		return ArchivedOperation{}, err
	}
	m, err := e.mutation(ctx, id)
	if err != nil {
		return ArchivedOperation{}, err
	}
	if m.WorkspaceID != workspace || m.Revision != previous {
		return ArchivedOperation{}, fail("OPERATION_SCOPE", "操作不属于该旧工作区修订")
	}
	out := ArchivedOperation{Operation: m.Operation, Path: m.plan.Path, Source: m.plan.Source, Recursive: m.plan.Recursive}
	if m.Kind == "entry.delete" {
		if m.Error != nil && m.Error.Code == "RESULT_EXPIRED" {
			out.DetailsExpired = true
		} else {
			detail, err := e.deleteStatus(ctx, m)
			if err != nil {
				return ArchivedOperation{}, err
			}
			out.Delete = &detail
		}
	}
	return out, nil
}

func (e *Engine) ArchivedDeleteOutcomes(ctx context.Context, workspace string, current, previous int64, id string, offset, limit int) ([]DeleteOutcome, int, error) {
	if !validID(id) {
		return nil, 0, fail("INVALID_ID", "操作标识无效")
	}
	e.commit.Lock()
	defer e.commit.Unlock()
	if err := e.checkArchiveScope(ctx, workspace, current, previous); err != nil {
		return nil, 0, err
	}
	return e.deleteOutcomes(ctx, workspace, previous, id, offset, limit)
}
