package hub

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strings"

	"workdeck/internal/protocol"
)

func (h *Hub) nodeCodexHistory(w http.ResponseWriter, r *http.Request, l login) {
	node := r.PathValue("id")
	var home, raw string
	if h.store.db.QueryRow("SELECT home,capabilities FROM nodes WHERE id=? AND revoked=0", node).Scan(&home, &raw) != nil {
		failure(w, 404, "节点不存在")
		return
	}
	if !h.nodeOnline(node) {
		failure(w, 409, "节点当前离线")
		return
	}
	var capabilities []string
	_ = json.Unmarshal([]byte(raw), &capabilities)
	if !slices.Contains(capabilities, "codex-history-v1") {
		failure(w, 409, "请先升级节点，以按标题选择 Codex 历史对话")
		return
	}
	cwd, cursor := r.URL.Query().Get("cwd"), r.URL.Query().Get("cursor")
	if cwd == "" {
		cwd = home
	}
	if !filepath.IsAbs(cwd) || len(cwd) > 4096 || strings.ContainsRune(cwd, 0) || len(cursor) > 4096 || strings.ContainsRune(cursor, 0) {
		failure(w, 400, "目录或分页参数无效")
		return
	}
	result, err := h.command(r.Context(), node, protocol.Message{Type: "codex.history", Path: cwd, CodexCursor: cursor})
	if err != nil {
		failure(w, 504, "读取 Codex 历史超时，请重试")
		return
	}
	if result.Error != "" {
		failure(w, 400, result.Error)
		return
	}
	listing := result.CodexHistory
	if listing == nil || len(listing.Entries) > 250 || len(listing.Cursor) > 4096 || len(listing.RunUser) > 128 {
		failure(w, 502, "节点返回了无效的对话列表")
		return
	}
	for _, entry := range listing.Entries {
		if entry.ID == "" || len(entry.ID) > 64 || len(entry.Title) > 1024 || len(entry.Cwd) > 4096 || !filepath.IsAbs(entry.Cwd) {
			failure(w, 502, "节点返回了无效的对话信息")
			return
		}
	}
	respond(w, 200, listing)
}
