package hub

import (
	"net/http"
	"time"

	"workdeck/internal/tailprobe"
)

type tailChallenge struct {
	loginHash string
	expires   time.Time
}
type tailBinding struct {
	device  string
	expires time.Time
}

func (h *Hub) startTailProbe(w http.ResponseWriter, _ *http.Request, l login) {
	if len(h.tailProbeSecret) == 0 {
		respond(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	h.authMu.Lock()
	defer h.authMu.Unlock()
	if !h.tailProbeLoginValid(l.Hash) {
		failure(w, http.StatusUnauthorized, "请先登录")
		return
	}
	now := time.Now()
	h.mu.Lock()
	for k, v := range h.tailChallenges {
		if !v.expires.After(now) {
			delete(h.tailChallenges, k)
		}
	}
	for k, v := range h.tailBindings {
		if !v.expires.After(now) {
			delete(h.tailBindings, k)
		}
	}
	if len(h.tailChallenges) >= 512 {
		h.mu.Unlock()
		failure(w, http.StatusTooManyRequests, "探测繁忙，请稍后重试")
		return
	}
	challenge := randomID()
	h.tailChallenges[challenge] = tailChallenge{loginHash: l.Hash, expires: now.Add(60 * time.Second)}
	h.mu.Unlock()
	respond(w, http.StatusOK, map[string]any{"enabled": true, "challenge": challenge, "probe_url": h.cfg.TailnetProbeURL})
}
func (h *Hub) completeTailProbe(w http.ResponseWriter, r *http.Request, l login) {
	if len(h.tailProbeSecret) == 0 {
		failure(w, http.StatusNotFound, "探测未启用")
		return
	}
	var req struct {
		Challenge string `json:"challenge"`
		Device    string `json:"device"`
		Proof     string `json:"proof"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !tailprobe.Verify(h.tailProbeSecret, req.Challenge, req.Device, req.Proof) {
		failure(w, http.StatusForbidden, "探测结果无效")
		return
	}
	h.authMu.Lock()
	defer h.authMu.Unlock()
	if !h.tailProbeLoginValid(l.Hash) {
		failure(w, http.StatusUnauthorized, "请先登录")
		return
	}
	h.mu.Lock()
	entry, ok := h.tailChallenges[req.Challenge]
	if ok && entry.loginHash == l.Hash && entry.expires.After(time.Now()) {
		delete(h.tailChallenges, req.Challenge)
		h.tailBindings[l.Hash] = tailBinding{device: req.Device, expires: time.Now().Add(2 * time.Minute)}
	} else {
		ok = false
	}
	h.mu.Unlock()
	if !ok {
		failure(w, http.StatusForbidden, "探测已过期或不属于当前会话")
		return
	}
	respond(w, http.StatusOK, map[string]any{"available": true, "valid_for_seconds": 120})
}

func (h *Hub) tailProbeLoginValid(hash string) bool {
	var expiry int64
	err := h.store.db.QueryRow("SELECT expires FROM logins WHERE hash=?", hash).Scan(&expiry)
	return err == nil && expiry > time.Now().Unix()
}

func (h *Hub) removeTailBindingsLocked(keep func(string) bool) {
	for k, v := range h.tailChallenges {
		if !keep(v.loginHash) {
			delete(h.tailChallenges, k)
		}
	}
	for k := range h.tailBindings {
		if !keep(k) {
			delete(h.tailBindings, k)
		}
	}
}
