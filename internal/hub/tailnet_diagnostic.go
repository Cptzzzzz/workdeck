package hub

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
	"workdeck/internal/tailprobe"
)

// This short-lived diagnostic is enabled only by a local administrator marker.
// It records numeric categories, never addresses, SDP or terminal content.
type tailnetDiagnosticMarker struct {
	Device  string `json:"device"`
	Node    string `json:"node"`
	Expires int64  `json:"expires"`
}
type tailnetDiagnosticRecord struct {
	Timestamp  int64 `json:"timestamp"`
	Route      uint8 `json:"route"`
	Peer       uint8 `json:"peer"`
	Local      uint8 `json:"local"`
	Remote     uint8 `json:"remote"`
	LocalType  uint8 `json:"local_type"`
	RemoteType uint8 `json:"remote_type"`
	RelayRTT   int32 `json:"relay_rtt_ms"`
	DirectRTT  int32 `json:"direct_rtt_ms"`
}

func (h *Hub) tailnetDiagnosticMarker() (tailnetDiagnosticMarker, bool) {
	var m tailnetDiagnosticMarker
	path := filepath.Join(h.cfg.DataDir, ".tailnet-diagnostic")
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return m, false
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 512 {
		return m, false
	}
	b, err := io.ReadAll(io.LimitReader(f, 513))
	if len(b) > 512 {
		return m, false
	}
	if err != nil {
		return m, false
	}
	if json.Unmarshal(b, &m) != nil || !tailprobe.ValidToken(m.Device, 64) || validateID(m.Node) != nil {
		return m, false
	}
	now := time.Now().Unix()
	return m, m.Expires > now && m.Expires-now <= 900
}
func (h *Hub) boundToDiagnostic(l login, m tailnetDiagnosticMarker) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	binding, ok := h.tailBindings[l.Hash]
	return ok && binding.device == m.Device && binding.expires.After(time.Now())
}
func (h *Hub) tailnetDiagnosticConfig(w http.ResponseWriter, _ *http.Request, l login) {
	m, ok := h.tailnetDiagnosticMarker()
	if !ok || !h.boundToDiagnostic(l, m) {
		respond(w, 200, map[string]any{"enabled": false})
		return
	}
	respond(w, 200, map[string]any{"enabled": true, "node_id": m.Node, "expires": m.Expires})
}
func (h *Hub) recordTailnetDiagnostic(w http.ResponseWriter, r *http.Request, l login) {
	m, ok := h.tailnetDiagnosticMarker()
	if !ok || !h.boundToDiagnostic(l, m) {
		failure(w, 403, "诊断未启用")
		return
	}
	var request struct {
		Terminal   string `json:"terminal"`
		Route      uint8  `json:"route"`
		Peer       uint8  `json:"peer"`
		Local      uint8  `json:"local"`
		Remote     uint8  `json:"remote"`
		LocalType  uint8  `json:"local_type"`
		RemoteType uint8  `json:"remote_type"`
		RelayRTT   int32  `json:"relay_rtt_ms"`
		DirectRTT  int32  `json:"direct_rtt_ms"`
	}
	if !decode(w, r, &request) {
		return
	}
	if validateID(request.Terminal) != nil || request.Route > 1 || request.Peer > 6 || request.Local > 3 || request.Remote > 3 || request.LocalType > 4 || request.RemoteType > 4 || request.RelayRTT < -1 || request.RelayRTT > 60000 || request.DirectRTT < -1 || request.DirectRTT > 60000 {
		failure(w, 400, "诊断格式无效")
		return
	}
	h.authMu.Lock()
	defer h.authMu.Unlock()
	if !h.tailProbeLoginValid(l.Hash) {
		failure(w, 401, "请先登录")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	binding, ok := h.tailBindings[l.Hash]
	if !ok || binding.device != m.Device || !binding.expires.After(time.Now()) {
		failure(w, 403, "诊断已失效")
		return
	}
	attached := false
	for _, a := range h.attachments {
		if a.loginHash == l.Hash && a.nodeID == m.Node && a.terminalID == request.Terminal {
			attached = true
			break
		}
	}
	if !attached {
		failure(w, 403, "终端未连接")
		return
	}
	if time.Since(h.tailTraceLast) < time.Second {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	path := filepath.Join(h.cfg.DataDir, "tailnet-diagnostic.jsonl")
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_CREAT|unix.O_APPEND|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		failure(w, 500, "诊断不可用")
		return
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 65536 {
		failure(w, 500, "诊断不可用")
		return
	}
	record := tailnetDiagnosticRecord{Timestamp: time.Now().Unix(), Route: request.Route, Peer: request.Peer, Local: request.Local, Remote: request.Remote, LocalType: request.LocalType, RemoteType: request.RemoteType, RelayRTT: request.RelayRTT, DirectRTT: request.DirectRTT}
	data, err := json.Marshal(record)
	if err != nil {
		failure(w, 500, "诊断不可用")
		return
	}
	data = append(data, '\n')
	if n, err := f.Write(data); err != nil || n != len(data) {
		if err == nil {
			err = io.ErrShortWrite
		}
		failure(w, 500, "诊断不可用")
		return
	}
	h.tailTraceLast = time.Now()
	w.WriteHeader(http.StatusNoContent)
}
