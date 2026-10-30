package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

type workspaceView struct {
	Initialized   bool             `json:"initialized"`
	State         string           `json:"state,omitempty"`
	Workspace     *files.Workspace `json:"workspace,omitempty"`
	PendingTarget string           `json:"pending_target,omitempty"`
}

func viewWorkspace(w workspaceRecord) workspaceView {
	return workspaceView{Initialized: true, State: w.State, Workspace: &w.Workspace, PendingTarget: w.PendingTarget}
}

func (h *Hub) getWorkspace(w http.ResponseWriter, r *http.Request, _ login) {
	terminal, err := h.store.terminal(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "终端不存在")
		return
	}
	if err != nil {
		failure(w, 500, "读取终端失败")
		return
	}
	record, err := h.store.workspaceByTerminal(r.Context(), terminal.ID)
	if errors.Is(err, sql.ErrNoRows) {
		respond(w, 200, workspaceView{})
		return
	}
	if err != nil {
		failure(w, 500, "读取工作区失败")
		return
	}
	respond(w, 200, viewWorkspace(record))
}

func (h *Hub) workspaceNodeAvailable(node string) bool {
	return h.workspaceNodeCapability(node, "workspace-control-v1")
}

func (h *Hub) workspaceNodeCapability(node, capability string) bool {
	var encoded string
	if h.store.db.QueryRow(`SELECT capabilities FROM nodes WHERE id=? AND revoked=0`, node).Scan(&encoded) != nil || !h.nodeOnline(node) {
		return false
	}
	var capabilities []string
	return json.Unmarshal([]byte(encoded), &capabilities) == nil && slices.Contains(capabilities, capability)
}

func (h *Hub) createWorkspace(w http.ResponseWriter, r *http.Request, _ login) {
	terminal := r.PathValue("id")
	lock := h.workspaceLock(terminal)
	lock.Lock()
	defer lock.Unlock()
	t, err := h.store.terminal(terminal)
	if errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "终端不存在")
		return
	}
	if err != nil {
		failure(w, 500, "读取终端失败")
		return
	}
	current, err := h.store.workspaceByTerminal(r.Context(), terminal)
	if err == nil && current.State != "initializing" {
		respond(w, 200, viewWorkspace(current))
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		failure(w, 500, "读取工作区失败")
		return
	}
	if !h.workspaceNodeAvailable(t.NodeID) {
		failure(w, 409, "节点离线或尚不支持工作区，请检查节点版本")
		return
	}
	current, err = h.store.reserveWorkspace(r.Context(), terminal)
	if err != nil {
		failure(w, 500, "保存工作区失败")
		return
	}
	if err = h.initializeWorkspace(r.Context(), current); err != nil {
		failure(w, 409, err.Error())
		return
	}
	current, err = h.store.workspaceByTerminal(r.Context(), terminal)
	if err != nil {
		failure(w, 500, "读取工作区失败")
		return
	}
	respond(w, 200, viewWorkspace(current))
}

func (h *Hub) initializeWorkspace(ctx context.Context, current workspaceRecord) error {
	result, err := h.command(ctx, current.NodeID, protocol.Message{Type: "workspace.register", TerminalID: current.TerminalID, WorkspaceID: current.ID})
	if err != nil {
		return errors.New("节点未确认工作区，请重试")
	}
	if result.Error != "" {
		return errors.New(result.Error)
	}
	if result.Workspace == nil || result.Workspace.ID != current.ID || result.Workspace.TerminalID != current.TerminalID {
		return errors.New("节点返回的工作区无效")
	}
	if err = h.store.confirmWorkspace(ctx, *result.Workspace); err != nil {
		return errors.New("保存工作区失败，请重试")
	}
	return nil
}

type workspaceChangeInput struct {
	Root     string `json:"root_path"`
	Revision int64  `json:"root_revision"`
}

func (h *Hub) changeWorkspace(w http.ResponseWriter, r *http.Request, _ login) {
	var input workspaceChangeInput
	if !decode(w, r, &input) {
		return
	}
	if !filepath.IsAbs(input.Root) || len(input.Root) > 4096 || strings.ContainsRune(input.Root, 0) || input.Revision < 1 {
		failure(w, 400, "目录或修订无效")
		return
	}
	terminal := r.PathValue("id")
	lock := h.workspaceLock(terminal)
	lock.Lock()
	defer lock.Unlock()
	current, err := h.store.workspaceByTerminal(r.Context(), terminal)
	if errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "工作区不存在")
		return
	}
	if err != nil {
		failure(w, 500, "读取工作区失败")
		return
	}
	if current.Revision != input.Revision || (current.State == "changing" && current.PendingTarget != input.Root) {
		failure(w, 409, "工作区已改变，请刷新后重试")
		return
	}
	if current.State != "ready" && current.State != "changing" {
		failure(w, 409, "工作区尚未初始化")
		return
	}
	if !h.workspaceNodeAvailable(current.NodeID) {
		failure(w, 409, "节点离线或尚不支持工作区，请检查节点版本")
		return
	}
	if current.State == "ready" {
		op := files.NewID(time.Now())
		if err = h.store.beginWorkspaceChange(r.Context(), current.ID, current.Revision, op, input.Root); err != nil {
			failure(w, 409, "工作区已改变，请刷新后重试")
			return
		}
		current.State, current.PendingID, current.PendingTarget = "changing", op, input.Root
		h.revokeWorkspaceFiles(current.ID)
	}
	if err = h.recoverWorkspaceChange(r.Context(), current); err != nil {
		failure(w, 409, err.Error())
		return
	}
	current, err = h.store.workspaceByTerminal(r.Context(), terminal)
	if err != nil {
		failure(w, 500, "读取工作区失败")
		return
	}
	respond(w, 200, viewWorkspace(current))
}

func (h *Hub) recoverWorkspaceChange(ctx context.Context, current workspaceRecord) error {
	msg := protocol.Message{TerminalID: current.TerminalID, WorkspaceID: current.ID, RootRevision: current.Revision, OperationID: current.PendingID, Path: current.PendingTarget}
	if current.PendingCandidate == "" {
		msg.Type = "workspace.prepare"
	} else {
		msg.Type = "workspace.status"
	}
	result, err := h.command(ctx, current.NodeID, msg)
	if err != nil {
		return errors.New("节点未确认目录切换，状态已保存，请稍后重试")
	}
	if result.Error != "" {
		// These prepare failures prove no operation was created. Transport and
		// worker failures are ambiguous and must retain the pending operation.
		if msg.Type == "workspace.prepare" && (result.ErrorCode == "ROOT_UNAVAILABLE" || result.ErrorCode == "INVALID_WORKSPACE" || result.ErrorCode == "OPERATION_EXPIRED") {
			if err = h.store.cancelWorkspaceChange(ctx, current.ID, current.Revision, current.PendingID); err != nil {
				return errors.New("保存目录切换状态失败，请重试")
			}
		}
		return errors.New(result.Error)
	}
	c := result.RootChange
	if c == nil || c.ID != current.PendingID || c.WorkspaceID != current.ID || c.OldRevision != current.Revision {
		return errors.New("节点返回的目录切换状态无效")
	}
	if c.State == "aborted" {
		if err = h.store.cancelWorkspaceChange(ctx, current.ID, current.Revision, current.PendingID); err != nil {
			return errors.New("保存目录切换状态失败，请重试")
		}
		return errors.New("目录切换已取消，请重新选择")
	}
	if c.State == "prepared" {
		if err = h.store.recordWorkspaceCandidate(ctx, *c); err != nil {
			return errors.New("节点返回的候选目录与已保存状态不一致")
		}
		msg.Type = "workspace.commit"
		result, err = h.command(ctx, current.NodeID, msg)
		if err == nil && result.ErrorCode == "WORKSPACE_BUSY" {
			// Pending saves need the old revision to remain usable. Abort only
			// after the node explicitly confirms it did not commit the switch.
			msg.Type = "workspace.abort"
			aborted, abortErr := h.command(ctx, current.NodeID, msg)
			if abortErr == nil && aborted.Error == "" && aborted.RootChange != nil && aborted.RootChange.ID == current.PendingID && aborted.RootChange.WorkspaceID == current.ID && aborted.RootChange.OldRevision == current.Revision && aborted.RootChange.State == "aborted" {
				if h.store.cancelWorkspaceChange(ctx, current.ID, current.Revision, current.PendingID) == nil {
					return errors.New("仍有未完成的文件保存，请先恢复或取消保存再切换目录")
				}
			}
			return errors.New("目录切换状态尚未确认，请稍后重试")
		}
		if err != nil || result.Error != "" {
			return errors.New("节点尚未确认目录切换，状态已保存，请稍后重试")
		}
		c = result.RootChange
	}
	if c == nil || c.ID != current.PendingID || c.WorkspaceID != current.ID || c.OldRevision != current.Revision || c.State != "committed" {
		return errors.New("节点返回的目录切换状态无效")
	}
	if err = h.store.finishWorkspaceChange(ctx, *c); err != nil {
		return errors.New("保存目录切换结果失败，请重试")
	}
	return nil
}

// A reconnecting node reports inventory immediately and periodically. Resume
// pending changes without relying on a browser to stay open; at most one
// recovery scan runs per node, and each terminal shares the HTTP operation's
// lock. A failed or ambiguous attempt leaves the durable record intact.
func (h *Hub) scheduleWorkspaceRecovery(node string) {
	h.mu.Lock()
	if h.agents[node] == nil {
		h.mu.Unlock()
		return
	}
	if h.workspaceRecovering == nil {
		h.workspaceRecovering = make(map[string]bool)
	}
	if h.workspaceRecovering[node] {
		h.mu.Unlock()
		return
	}
	h.workspaceRecovering[node] = true
	h.mu.Unlock()
	go func() {
		defer func() { h.mu.Lock(); delete(h.workspaceRecovering, node); h.mu.Unlock() }()
		rows, err := h.store.db.Query(`SELECT terminal_id FROM workspaces WHERE node_id=? AND state IN ('initializing','changing')`, node)
		if err != nil {
			return
		}
		var terminals []string
		for rows.Next() {
			var terminal string
			if rows.Scan(&terminal) != nil {
				rows.Close()
				return
			}
			terminals = append(terminals, terminal)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return
		}
		for _, terminal := range terminals {
			lock := h.workspaceLock(terminal)
			lock.Lock()
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
			current, err := h.store.workspaceByTerminal(ctx, terminal)
			if err == nil && current.NodeID == node && h.workspaceNodeAvailable(node) {
				switch current.State {
				case "initializing":
					_ = h.initializeWorkspace(ctx, current)
				case "changing":
					_ = h.recoverWorkspaceChange(ctx, current)
				}
			}
			cancel()
			lock.Unlock()
		}
	}()
}
