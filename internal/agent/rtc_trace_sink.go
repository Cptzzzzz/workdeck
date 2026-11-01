package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"workdeck/internal/protocol"
)

// The marker is deliberately per-node and short-lived. Tracing is off by default.
func rtcTraceEnabled(dir string) bool {
	if dir == "" {
		return false
	}
	data, err := os.ReadFile(filepath.Join(dir, ".ice-trace-until"))
	if err != nil || len(data) > 32 {
		return false
	}
	until, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	now := time.Now().Unix()
	return err == nil && until > now && until-now <= 1800
}

var rtcTraceCreateMu sync.Mutex

type rtcTraceSink struct {
	mu      sync.Mutex
	file    *os.File
	started time.Time
	lines   int
	dir     string
}

func openRTCTrace(dir string) *rtcTraceSink {
	rtcTraceCreateMu.Lock()
	defer rtcTraceCreateMu.Unlock()
	if !rtcTraceEnabled(dir) {
		return nil
	}
	folder := filepath.Join(dir, "ice-traces")
	if err := os.MkdirAll(folder, 0700); err != nil {
		return nil
	}
	if err := os.Chmod(folder, 0700); err != nil {
		return nil
	}
	entries, err := os.ReadDir(folder)
	if err != nil {
		return nil
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "attempt-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			count++
		}
	}
	if count >= 10 {
		return nil
	}
	f, err := os.CreateTemp(folder, "attempt-*.jsonl")
	if err != nil {
		return nil
	}
	return &rtcTraceSink{file: f, started: time.Now(), dir: dir}
}
func (s *rtcTraceSink) write(side string, browser *protocol.RTCBrowserTrace, node *protocol.RTCNodeDiagnostic) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil || s.lines >= 80 || time.Since(s.started) > time.Minute || !rtcTraceEnabled(s.dir) {
		return
	}
	data, err := json.Marshal(struct {
		Side      string                      `json:"side"`
		ElapsedMs int64                       `json:"elapsedMs"`
		Browser   *protocol.RTCBrowserTrace   `json:"browser,omitempty"`
		Node      *protocol.RTCNodeDiagnostic `json:"node,omitempty"`
	}{side, time.Since(s.started).Milliseconds(), browser, node})
	if err != nil || len(data) > 32768 {
		return
	}
	data = append(data, '\n')
	if _, err = s.file.Write(data); err == nil {
		s.lines++
	}
}
func (s *rtcTraceSink) close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
}
func (l *terminalLink) recordBrowserTrace(v protocol.RTCBrowserTrace) {
	// Numeric-only data is bounded and cannot contain arbitrary text or addresses.
	if v.ElapsedMs > 120000 || v.Stage > 20 || v.Outcome > 20 || v.ICE > 20 || v.Connection > 20 {
		return
	}
	l.mu.Lock()
	sink := l.trace
	l.mu.Unlock()
	sink.write("browser", &v, nil)
}
