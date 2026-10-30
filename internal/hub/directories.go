package hub

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"workdeck/internal/protocol"
)

func (h *Hub) directories(w http.ResponseWriter, r *http.Request, l login) {
	node := r.PathValue("id")
	var capabilities string
	if h.store.db.QueryRow("SELECT capabilities FROM nodes WHERE id=? AND revoked=0", node).Scan(&capabilities) != nil {
		failure(w, 404, "节点不存在")
		return
	}
	if !h.nodeOnline(node) {
		failure(w, 409, "节点当前离线")
		return
	}
	var supported []string
	_ = json.Unmarshal([]byte(capabilities), &supported)
	if !slices.Contains(supported, "directories") {
		failure(w, 409, "请先升级此节点的 Agent，以启用目录选择")
		return
	}
	path := r.URL.Query().Get("path")
	if len(path) > 4096 || strings.ContainsRune(path, 0) || path != "" && !filepath.IsAbs(path) {
		failure(w, 400, "目录必须是有效的绝对路径")
		return
	}
	result, err := h.command(r.Context(), node, protocol.Message{Type: "directories", Path: path, IncludeHidden: r.URL.Query().Get("hidden") == "1"})
	if err != nil {
		failure(w, 504, "读取节点目录超时，请重试")
		return
	}
	if result.Error != "" {
		failure(w, 400, result.Error)
		return
	}
	if result.Directory == nil {
		failure(w, 502, "节点返回了无效的目录信息")
		return
	}
	respond(w, 200, result.Directory)
}
