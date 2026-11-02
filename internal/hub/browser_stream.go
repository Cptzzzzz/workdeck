package hub

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
	"workdeck/internal/protocol"
)

type browserPeer interface {
	Write(int, []byte) error
	JSON(any) error
	Close()
	Heartbeat(<-chan struct{})
	ReadMessage() (int, []byte, error)
}
type streamPacket struct {
	Kind int    `json:"kind"`
	Data []byte `json:"data"`
}
type streamBrowser struct {
	writer http.ResponseWriter
	login  string
	input  chan streamPacket
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
}

func (s *streamBrowser) Close() { s.once.Do(func() { close(s.done) }) }
func (s *streamBrowser) ReadMessage() (int, []byte, error) {
	select {
	case p := <-s.input:
		return p.Kind, p.Data, nil
	case <-s.done:
		return 0, nil, io.EOF
	}
}
func (s *streamBrowser) Write(kind int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.done:
		return io.EOF
	default:
	}
	controller := http.NewResponseController(s.writer)
	_ = controller.SetWriteDeadline(time.Now().Add(12 * time.Second))
	defer controller.SetWriteDeadline(time.Time{})
	b, err := json.Marshal(streamPacket{kind, data})
	if err != nil {
		return err
	}
	if _, err = s.writer.Write(append(append([]byte("data: "), b...), '\n', '\n')); err != nil {
		return err
	}
	return controller.Flush()
}
func (s *streamBrowser) JSON(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return s.Write(1, b)
}
func (s *streamBrowser) Heartbeat(done <-chan struct{}) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-s.done:
			return
		case <-t.C:
			if s.Write(0, nil) != nil {
				s.Close()
				return
			}
		}
	}
}
func (h *Hub) terminalStream(w http.ResponseWriter, r *http.Request, l login) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Workdeck-CSRF")), []byte(l.CSRF)) != 1 {
		failure(w, 403, "请求校验失败")
		return
	}
	h.serveTerminalBrowser(w, r, l, true)
}
func (h *Hub) newStreamBrowser(w http.ResponseWriter, r *http.Request, l login) (*streamBrowser, func(), error) {
	s := &streamBrowser{writer: w, login: l.Hash, input: make(chan streamPacket, 128), done: make(chan struct{})}
	id := randomID()
	h.mu.Lock()
	count := 0
	for _, v := range h.browserStreams {
		if v.login == l.Hash {
			count++
		}
	}
	if count >= 64 || len(h.browserStreams) >= 1024 {
		h.mu.Unlock()
		failure(w, 429, "终端连接过多")
		return nil, nil, errors.New("stream limit")
	}
	if h.browserStreams == nil {
		h.browserStreams = map[string]*streamBrowser{}
	}
	h.browserStreams[id] = s
	h.mu.Unlock()
	cleanup := func() {
		s.Close()
		h.mu.Lock()
		delete(h.browserStreams, id)
		h.mu.Unlock()
		s.mu.Lock()
		s.mu.Unlock()
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Content-Encoding", "identity")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Workdeck-Stream", id)
	w.WriteHeader(200)
	// A first body chunk makes reverse proxies forward the response headers
	// before the browser sends the deferred terminal selection message.
	if _, err := w.Write([]byte(": connected\n\n")); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		cleanup()
		return nil, nil, err
	}
	return s, cleanup, nil
}
func (h *Hub) terminalStreamInput(w http.ResponseWriter, r *http.Request, l login) {
	h.mu.Lock()
	s := h.browserStreams[r.PathValue("stream")]
	h.mu.Unlock()
	if s == nil || s.login != l.Hash {
		failure(w, 404, "终端连接不存在")
		return
	}
	var input struct {
		Packets []streamPacket `json:"packets"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || len(input.Packets) == 0 || len(input.Packets) > 16 {
		failure(w, 400, "终端输入格式无效")
		return
	}
	total := 0
	for _, p := range input.Packets {
		total += len(p.Data)
		if (p.Kind != 1 && p.Kind != 2) || len(p.Data) > 65536 || (p.Kind == 2 && len(p.Data) > 32768) || total > 256<<10 {
			failure(w, 400, "终端输入过大")
			return
		}
	}
	for _, p := range input.Packets {
		select {
		case s.input <- p:
		case <-s.done:
			failure(w, 410, "终端连接已关闭")
			return
		case <-r.Context().Done():
			return
		}
	}
	respond(w, 200, map[string]bool{"ok": true})
}

// Keep the same browser forwarding implementation for both transports.
var _ browserPeer = (*protocol.Socket)(nil)
