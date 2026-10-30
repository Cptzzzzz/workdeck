package agent

import (
	"context"
	"errors"
	"path/filepath"

	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

// workspaceControl handles only metadata and root transitions. File contents
// travel over a separate connection; this path never manages terminal tasks.
func (a *Agent) workspaceControl(ctx context.Context, pool *fileWorkerPool, msg protocol.Message) protocol.Message {
	result := protocol.Message{Type: "result", RequestID: msg.RequestID, TerminalID: msg.TerminalID}
	fail := func(err error) protocol.Message {
		var detail *files.Error
		if errors.As(err, &detail) {
			result.Error, result.ErrorCode = detail.Message, detail.Code
		} else {
			result.Error, result.ErrorCode = "节点文件服务不可用，请重试", "WORKER_UNAVAILABLE"
		}
		return result
	}
	if !validID(msg.TerminalID) || !validID(msg.WorkspaceID) {
		return fail(&files.Error{Code: "INVALID_WORKSPACE", Message: "工作区参数无效"})
	}
	a.sessions.mu.Lock()
	session, err := a.sessions.read(msg.TerminalID)
	a.sessions.mu.Unlock()
	if err != nil || session.ID != msg.TerminalID {
		return fail(&files.Error{Code: "TERMINAL_NOT_FOUND", Message: "节点上没有此终端记录"})
	}
	worker, err := pool.forTerminal(ctx, msg.TerminalID)
	if err != nil {
		return fail(err)
	}
	if msg.Type == "workspace.register" {
		if !filepath.IsAbs(session.Cwd) {
			return fail(&files.Error{Code: "INVALID_WORKSPACE", Message: "终端初始目录无效"})
		}
		// The root and execution account are taken exclusively from the node's
		// private session record, never from a browser-supplied path or username.
		spec := files.Workspace{ID: msg.WorkspaceID, TerminalID: session.ID, Root: session.Cwd, Revision: 1}
		var registered files.Workspace
		if err = worker.Call(ctx, msg.Type, "", 0, spec, &registered); err != nil {
			return fail(err)
		}
		result.Workspace = &registered
		return result
	}
	var identity files.Workspace
	if err = worker.Call(ctx, "workspace.identity", msg.WorkspaceID, 0, map[string]any{"terminal_id": session.ID}, &identity); err != nil {
		return fail(err)
	}
	if identity.ID != msg.WorkspaceID || identity.TerminalID != session.ID {
		return fail(&files.Error{Code: "OPERATION_SCOPE", Message: "工作区不属于此终端"})
	}
	var params any
	switch msg.Type {
	case "workspace.prepare":
		params = map[string]any{"op_id": msg.OperationID, "root_path": msg.Path}
	case "workspace.commit", "workspace.abort", "workspace.status":
		params = map[string]any{"op_id": msg.OperationID}
	default:
		return fail(&files.Error{Code: "INVALID_REQUEST", Message: "不支持此工作区操作"})
	}
	var change files.RootChange
	if err = worker.Call(ctx, msg.Type, msg.WorkspaceID, msg.RootRevision, params, &change); err != nil {
		return fail(err)
	}
	result.RootChange = &change
	return result
}
