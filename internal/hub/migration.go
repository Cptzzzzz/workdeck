package hub

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

type migrationTicket struct {
	loginHash string
	username  string
	expires   time.Time
}

// Migration is explicitly enabled for one previous origin. The old origin
// issues a short-lived, single-use ticket; the original session cookie never
// leaves that origin. Browser-local records travel directly between frames.
func (h *Hub) migrationConfig(w http.ResponseWriter, _ *http.Request) {
	respond(w, http.StatusOK, map[string]string{"legacyOrigin": h.cfg.LegacyOrigin, "publicOrigin": h.cfg.PublicURL})
}

func (h *Hub) migrationIssue(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != h.cfg.LegacyOrigin {
		failure(w, http.StatusForbidden, "请求来源不匹配")
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	l, ok := h.loginFor(r)
	if !ok {
		failure(w, http.StatusUnauthorized, "原站点尚未登录")
		return
	}
	ticket := randomID()
	now := time.Now()
	h.migrationMu.Lock()
	defer h.migrationMu.Unlock()
	for key, old := range h.migrationTickets {
		if !old.expires.After(now) {
			delete(h.migrationTickets, key)
		}
	}
	if len(h.migrationTickets) >= 1000 {
		failure(w, http.StatusTooManyRequests, "迁移请求过多，请稍后重试")
		return
	}
	h.migrationTickets[digest(ticket)] = migrationTicket{loginHash: l.Hash, username: l.Username, expires: now.Add(90 * time.Second)}
	respond(w, http.StatusOK, map[string]string{"ticket": ticket, "username": l.Username})
}

func (h *Hub) migrationRedeem(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != h.cfg.PublicURL {
		failure(w, http.StatusForbidden, "请求来源不匹配")
		return
	}
	var in struct {
		Ticket string `json:"ticket"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Ticket) != 48 {
		failure(w, http.StatusBadRequest, "迁移凭据无效")
		return
	}
	h.migrationMu.Lock()
	grant, ok := h.migrationTickets[digest(in.Ticket)]
	delete(h.migrationTickets, digest(in.Ticket))
	h.migrationMu.Unlock()
	if !ok || !grant.expires.After(time.Now()) {
		failure(w, http.StatusUnauthorized, "迁移凭据已过期")
		return
	}
	h.authMu.Lock()
	defer h.authMu.Unlock()
	var exists int
	err := h.store.db.QueryRow("SELECT count(*) FROM logins WHERE hash=? AND username=? AND expires>?", grant.loginHash, grant.username, time.Now().Unix()).Scan(&exists)
	if err != nil || exists != 1 {
		failure(w, http.StatusUnauthorized, "原登录状态已失效")
		return
	}
	token := randomID()
	expires := time.Now().Add(h.cfg.SessionTTL).Unix()
	if _, err = h.store.db.Exec("INSERT INTO logins VALUES(?,?,?)", digest(token), grant.username, expires); err != nil {
		failure(w, http.StatusInternalServerError, "保存登录状态失败")
		return
	}
	h.setLoginCookie(w, token, expires)
	respond(w, http.StatusOK, map[string]string{"username": grant.username})
}

func (h *Hub) migrationFrame(w http.ResponseWriter, r *http.Request) {
	// The frame is useful only on the previous origin and may be embedded only
	// by the configured new origin; do not weaken framing for other pages.
	legacyHost := strings.TrimPrefix(h.cfg.LegacyOrigin, "https://")
	if r.Host != legacyHost {
		http.NotFound(w, r)
		return
	}
	w.Header().Del("X-Frame-Options")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors "+h.cfg.PublicURL+"; base-uri 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprint(w, "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Workdeck 迁移</title><script src=\"/migration/bridge.js\" defer></script></html>")
}

func (h *Hub) migrationScript(w http.ResponseWriter, r *http.Request) {
	legacyHost := strings.TrimPrefix(h.cfg.LegacyOrigin, "https://")
	if r.Host != legacyHost {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(h.cfg.AssetsDir, "migration-bridge.js"))
}
