package fileworker

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"workdeck/internal/files"
)

const snapshotBudget = 64 << 20

type directoryQuery struct {
	Path     string
	Hidden   bool
	Filter   string
	Snapshot string
	Offset   int
}

type directorySnapshot struct {
	workspace string
	revision  int64
	query     directoryQuery
	listing   files.Listing
	size      int
	created   time.Time
}

type directoryPage struct {
	Path      string        `json:"path"`
	Snapshot  string        `json:"snapshot"`
	Entries   []files.Entry `json:"entries"`
	Next      int           `json:"next"`
	HasMore   bool          `json:"has_more"`
	Truncated bool          `json:"truncated"`
}

func (s *Server) listPage(ctx context.Context, r request, q directoryQuery) (directoryPage, error) {
	if len(q.Filter) > 256 || q.Offset < 0 || len(q.Snapshot) > 128 {
		return directoryPage{}, &files.Error{Code: "INVALID_REQUEST", Message: "目录分页参数无效"}
	}
	now := time.Now()
	var snap directorySnapshot
	if q.Snapshot == "" {
		if q.Offset != 0 {
			return directoryPage{}, &files.Error{Code: "INVALID_REQUEST", Message: "缺少目录快照"}
		}
		listing, err := s.engine.List(ctx, r.WorkspaceID, r.Revision, q.Path, q.Hidden, q.Filter)
		if err != nil {
			return directoryPage{}, err
		}
		encoded, err := json.Marshal(listing)
		if err != nil {
			return directoryPage{}, err
		}
		if len(encoded) > snapshotBudget {
			return directoryPage{}, &files.Error{Code: "QUOTA_EXCEEDED", Message: "目录快照过大，请缩小筛选范围"}
		}
		q.Snapshot = files.NewID(now)
		snap = directorySnapshot{workspace: r.WorkspaceID, revision: r.Revision, query: q, listing: listing, size: len(encoded), created: now}
		s.mu.Lock()
		for id, item := range s.snapshots {
			if now.Sub(item.created) > 30*time.Second {
				s.snapshotBytes -= item.size
				delete(s.snapshots, id)
			}
		}
		if len(s.snapshots) >= 32 || s.snapshotBytes+snap.size > snapshotBudget {
			type age struct {
				id string
				at time.Time
			}
			ordered := make([]age, 0, len(s.snapshots))
			for id, item := range s.snapshots {
				ordered = append(ordered, age{id, item.created})
			}
			sort.Slice(ordered, func(i, j int) bool { return ordered[i].at.Before(ordered[j].at) })
			for _, item := range ordered {
				if len(s.snapshots) < 32 && s.snapshotBytes+snap.size <= snapshotBudget {
					break
				}
				s.snapshotBytes -= s.snapshots[item.id].size
				delete(s.snapshots, item.id)
			}
		}
		s.snapshots[q.Snapshot] = snap
		s.snapshotBytes += snap.size
		s.mu.Unlock()
	} else {
		s.mu.Lock()
		item, ok := s.snapshots[q.Snapshot]
		s.mu.Unlock()
		if !ok || now.Sub(item.created) > 30*time.Second {
			return directoryPage{}, &files.Error{Code: "SNAPSHOT_EXPIRED", Message: "目录快照已过期，请刷新"}
		}
		if item.workspace != r.WorkspaceID || item.revision != r.Revision || item.query.Path != q.Path || item.query.Hidden != q.Hidden || item.query.Filter != q.Filter {
			return directoryPage{}, &files.Error{Code: "OPERATION_SCOPE", Message: "目录快照不属于当前请求"}
		}
		if err := s.engine.ValidateWorkspace(ctx, r.WorkspaceID, r.Revision); err != nil {
			return directoryPage{}, err
		}
		snap = item
	}
	if q.Offset > len(snap.listing.Entries) {
		return directoryPage{}, &files.Error{Code: "INVALID_REQUEST", Message: "目录分页位置无效"}
	}
	page := directoryPage{Path: q.Path, Snapshot: q.Snapshot, Entries: []files.Entry{}, Next: q.Offset, Truncated: snap.listing.Truncated}
	for page.Next < len(snap.listing.Entries) && len(page.Entries) < 256 {
		page.Entries = append(page.Entries, snap.listing.Entries[page.Next])
		page.Next++
		page.HasMore = page.Next < len(snap.listing.Entries)
		encoded, err := json.Marshal(response{ID: r.ID, Result: page})
		if err != nil {
			return directoryPage{}, err
		}
		if len(encoded) > 28<<10 {
			page.Entries = page.Entries[:len(page.Entries)-1]
			page.Next--
			page.HasMore = true
			break
		}
	}
	if len(page.Entries) == 0 && page.HasMore {
		return directoryPage{}, &files.Error{Code: "ENTRY_TOO_LARGE", Message: "目录条目超出大小限制"}
	}
	return page, nil
}
