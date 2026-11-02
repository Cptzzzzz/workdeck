package hub

import (
	"log"
	"net/http"
)

func validStartupTrace(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Numeric milestones only: never record terminal output, URLs, or credentials.
func (h *Hub) recordTerminalStartup(w http.ResponseWriter, r *http.Request, _ login) {
	var v struct {
		Trace   string `json:"trace"`
		Stage   string `json:"stage"`
		Elapsed int    `json:"elapsed_ms"`
		Open    int    `json:"open_ms"`
		Ready   int    `json:"ready_ms"`
	}
	if !decode(w, r, &v) {
		return
	}
	if !validStartupTrace(v.Trace) || (v.Stage != "waiting" && v.Stage != "rendered" && v.Stage != "closed") || v.Elapsed < 0 || v.Elapsed > 3600000 || v.Open < -1 || v.Open > v.Elapsed || v.Ready < -1 || v.Ready > v.Elapsed || (v.Ready >= 0 && (v.Open < 0 || v.Ready < v.Open)) {
		failure(w, 400, "启动计时格式无效")
		return
	}
	log.Printf("terminal startup trace=%s browser_stage=%s elapsed_ms=%d open_ms=%d ready_ms=%d", v.Trace, v.Stage, v.Elapsed, v.Open, v.Ready)
	respond(w, 200, map[string]bool{"ok": true})
}
