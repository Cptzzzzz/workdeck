package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"

	"workdeck/internal/files"
)

// workspaceRecord is persisted before contacting the node, so recovery can
// retry the same initialization or root-change operation after a disconnect.
// Only ready workspaces may be used to issue file connection tickets.
type workspaceRecord struct {
	files.Workspace
	NodeID           string
	State            string
	PendingID        string
	PendingTarget    string
	PendingCandidate string
}

var errWorkspaceState = errors.New("workspace state or revision changed")

const workspaceFields = `id,terminal_id,node_id,root_path,root_revision,run_user,device,inode,state,pending_id,pending_target,pending_candidate`

func scanWorkspace(row interface{ Scan(...any) error }) (workspaceRecord, error) {
	var w workspaceRecord
	var device, inode string
	err := row.Scan(&w.ID, &w.TerminalID, &w.NodeID, &w.Root, &w.Revision, &w.User, &device, &inode, &w.State, &w.PendingID, &w.PendingTarget, &w.PendingCandidate)
	if err != nil {
		return w, err
	}
	if device != "" {
		if w.Device, err = strconv.ParseUint(device, 10, 64); err != nil {
			return w, err
		}
	}
	if inode != "" {
		if w.Inode, err = strconv.ParseUint(inode, 10, 64); err != nil {
			return w, err
		}
	}
	return w, nil
}

func (s *Store) workspaceByTerminal(ctx context.Context, terminal string) (workspaceRecord, error) {
	return scanWorkspace(s.db.QueryRowContext(ctx, `SELECT `+workspaceFields+` FROM workspaces WHERE terminal_id=?`, terminal))
}

// reserveWorkspace is idempotent even when two browsers open the same terminal.
// The original cwd comes from the stored terminal, never from the browser.
func (s *Store) reserveWorkspace(ctx context.Context, terminal string) (workspaceRecord, error) {
	_, err := s.db.ExecContext(ctx, `INSERT INTO workspaces(id,terminal_id,node_id,root_path,root_revision,state)
 SELECT ?,id,node_id,cwd,1,'initializing' FROM terminals WHERE id=? ON CONFLICT(terminal_id) DO NOTHING`, randomID(), terminal)
	if err != nil {
		return workspaceRecord{}, err
	}
	return s.workspaceByTerminal(ctx, terminal)
}

func changed(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errWorkspaceState
	}
	return nil
}

// The candidate identity is supplied by the node and is not inferred from a
// browser path. Registration may canonicalize the initial path.
func (s *Store) confirmWorkspace(ctx context.Context, spec files.Workspace) error {
	if spec.ID == "" || spec.TerminalID == "" || spec.Revision != 1 || !filepath.IsAbs(spec.Root) || spec.User == "" || spec.Inode == 0 {
		return errWorkspaceState
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET root_path=?,run_user=?,device=?,inode=?,state='ready' WHERE id=? AND terminal_id=? AND state='initializing' AND root_revision=1`, spec.Root, spec.User, strconv.FormatUint(spec.Device, 10), strconv.FormatUint(spec.Inode, 10), spec.ID, spec.TerminalID)
	return changed(result, err)
}

// Store the operation ID and requested target before sending prepare to the
// node. This also prevents issuing new file tickets until recovery completes.
func (s *Store) beginWorkspaceChange(ctx context.Context, id string, revision int64, opID, target string) error {
	if opID == "" || !filepath.IsAbs(target) || revision < 1 {
		return errWorkspaceState
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET state='changing',pending_id=?,pending_target=?,pending_candidate='' WHERE id=? AND state='ready' AND root_revision=?`, opID, target, id, revision)
	return changed(result, err)
}

func (s *Store) recordWorkspaceCandidate(ctx context.Context, c files.RootChange) error {
	if c.State != "prepared" || c.ID == "" || c.Candidate.ID != c.WorkspaceID || c.Candidate.Revision != c.OldRevision+1 || !filepath.IsAbs(c.Candidate.Root) || c.Candidate.User == "" || c.Candidate.Inode == 0 {
		return errWorkspaceState
	}
	data, err := json.Marshal(c.Candidate)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET pending_candidate=? WHERE id=? AND state='changing' AND pending_id=? AND root_revision=? AND terminal_id=? AND run_user=? AND (pending_candidate='' OR pending_candidate=?)`, string(data), c.WorkspaceID, c.ID, c.OldRevision, c.Candidate.TerminalID, c.Candidate.User, string(data))
	return changed(result, err)
}

// Promote only the exact candidate acknowledged as committed by the node.
func (s *Store) finishWorkspaceChange(ctx context.Context, c files.RootChange) error {
	if c.State != "committed" {
		return errWorkspaceState
	}
	data, err := json.Marshal(c.Candidate)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET root_path=?,root_revision=?,device=?,inode=?,state='ready',pending_id='',pending_target='',pending_candidate='' WHERE id=? AND state='changing' AND pending_id=? AND root_revision=? AND terminal_id=? AND run_user=? AND pending_candidate=?`, c.Candidate.Root, c.Candidate.Revision, strconv.FormatUint(c.Candidate.Device, 10), strconv.FormatUint(c.Candidate.Inode, 10), c.WorkspaceID, c.ID, c.OldRevision, c.Candidate.TerminalID, c.Candidate.User, string(data))
	return changed(result, err)
}

// Abort only after the node has confirmed cancellation (or that no prepare was
// recorded); a caller must never infer cancellation from a lost connection.
func (s *Store) cancelWorkspaceChange(ctx context.Context, id string, revision int64, opID string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET state='ready',pending_id='',pending_target='',pending_candidate='' WHERE id=? AND state='changing' AND pending_id=? AND root_revision=?`, id, opID, revision)
	return changed(result, err)
}
