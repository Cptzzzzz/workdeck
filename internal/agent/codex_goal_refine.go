package agent

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"workdeck/internal/protocol"
)

// Codex turn IDs are UUIDv7; older app servers may omit startedAt.
func turnStartFromUUID(id string) int64 {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' || id[14] != '7' || !strings.ContainsRune("89abAB", rune(id[19])) {
		return 0
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return 0
		}
	}
	millis, e := strconv.ParseInt(id[:8]+id[9:13], 16, 64)
	if e != nil || millis <= 0 {
		return 0
	}
	return millis / 1000
}

type goalResolution struct {
	event            string
	expires          time.Time
	updated, started int64
	ok               bool
}

// The helper inside a live tmux session may be an older binary. Query its
// existing private app-server read-only, using only thread and turn metadata.
func (a *Agent) refineManagedGoal(id string, in *protocol.CodexObservation) *protocol.CodexObservation {
	if in == nil || !in.Managed || in.Goal == nil || in.Goal.Status != "complete" || in.Status != "goal_complete" {
		return in
	}
	out := *in
	goal := *in.Goal
	out.Goal = &goal
	if goal.UpdatedAt > 0 && out.TurnStartedAt > 0 {
		if out.TurnStartedAt > goal.UpdatedAt {
			out.Status = "turn_ended"
		}
		return &out
	}
	a.goalMu.Lock()
	defer a.goalMu.Unlock()
	if a.goalResolutions == nil {
		a.goalResolutions = map[string]goalResolution{}
	}
	resolution, ok := a.goalResolutions[id]
	if !ok || resolution.event != in.EventID || time.Now().After(resolution.expires) {
		updated, started, found := a.findGoalTimes(id, in)
		resolution = goalResolution{event: in.EventID, updated: updated, started: started, ok: found, expires: time.Now().Add(3 * time.Second)}
		a.goalResolutions[id] = resolution
	}
	if !resolution.ok {
		out.Status = "unknown"
		return &out
	}
	out.Goal.UpdatedAt = resolution.updated
	out.TurnStartedAt = resolution.started
	if out.TurnStartedAt > out.Goal.UpdatedAt {
		out.Status = "turn_ended"
	}
	return &out
}

func (a *Agent) findGoalTimes(id string, in *protocol.CodexObservation) (int64, int64, bool) {
	if in.ThreadID == "" || in.TurnID == "" || in.Goal == nil {
		return 0, 0, false
	}
	session, e := a.sessions.read(id)
	if e != nil {
		return 0, 0, false
	}
	uid := uint64(os.Geteuid())
	if session.RunUser != "" {
		account, e := user.Lookup(session.RunUser)
		if e != nil {
			return 0, 0, false
		}
		uid, e = strconv.ParseUint(account.Uid, 10, 32)
		if e != nil {
			return 0, 0, false
		}
	}
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "workdeck-codex-*"))
	deadline := time.Now().Add(5 * time.Second)
	for _, dir := range dirs {
		if time.Now().After(deadline) {
			break
		}
		info, e := os.Lstat(dir)
		if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
			continue
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || uint64(stat.Uid) != uid {
			continue
		}
		sock := filepath.Join(dir, "rpc.sock")
		// Codex may expose rpc.sock as a symlink to its private control socket.
		// The containing directory is already owner-only; verify the resolved
		// endpoint is a socket owned by the same session account.
		info, e = os.Stat(sock)
		if e != nil || info.Mode()&os.ModeSocket == 0 {
			continue
		}
		socketStat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || uint64(socketStat.Uid) != uid {
			continue
		}
		rpc, e := connectCodex(sock)
		if e != nil {
			continue
		}
		updated, started, matched := readGoalTimes(rpc, in)
		rpc.ws.Close()
		if matched {
			return updated, started, true
		}
	}
	return 0, 0, false
}

func readGoalTimes(rpc *codexRPC, in *protocol.CodexObservation) (int64, int64, bool) {
	var loaded struct {
		Data []string `json:"data"`
	}
	if rpc.call("thread/loaded/list", map[string]any{}, &loaded) != nil {
		return 0, 0, false
	}
	found := false
	for _, id := range loaded.Data {
		if id == in.ThreadID {
			found = true
			break
		}
	}
	if !found {
		return 0, 0, false
	}
	var response struct {
		Goal *struct {
			Status    string `json:"status"`
			CreatedAt int64  `json:"createdAt"`
			UpdatedAt int64  `json:"updatedAt"`
		} `json:"goal"`
	}
	if rpc.call("thread/goal/get", map[string]any{"threadId": in.ThreadID}, &response) != nil || response.Goal == nil || response.Goal.Status != "complete" || response.Goal.CreatedAt != in.Goal.CreatedAt || response.Goal.UpdatedAt <= 0 {
		return 0, 0, false
	}
	started := turnStartFromUUID(in.TurnID)
	if started == 0 {
		var turns struct {
			Data []struct {
				ID        string `json:"id"`
				StartedAt *int64 `json:"startedAt"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		params := map[string]any{"threadId": in.ThreadID, "limit": 50, "sortDirection": "desc", "itemsView": "notLoaded"}
		for page := 0; page < 2; page++ {
			if rpc.call("thread/turns/list", params, &turns) != nil {
				break
			}
			for _, t := range turns.Data {
				if t.ID == in.TurnID && t.StartedAt != nil {
					started = *t.StartedAt
					break
				}
			}
			if started > 0 || turns.NextCursor == nil || *turns.NextCursor == "" {
				break
			}
			params["cursor"] = *turns.NextCursor
		}
	}
	if started <= 0 {
		return 0, 0, false
	}
	return response.Goal.UpdatedAt, started, true
}
