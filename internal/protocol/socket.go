package protocol

import (
	"github.com/gorilla/websocket"
	"sync"
	"time"
)

type Socket struct {
	Conn *websocket.Conn
	mu   sync.Mutex
}

func (s *Socket) Write(kind int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.Conn.SetWriteDeadline(time.Now().Add(12 * time.Second))
	return s.Conn.WriteMessage(kind, data)
}
func (s *Socket) JSON(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.Conn.SetWriteDeadline(time.Now().Add(12 * time.Second))
	return s.Conn.WriteJSON(v)
}
func (s *Socket) Close() { _ = s.Conn.Close() }
func (s *Socket) Heartbeat(done <-chan struct{}) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			if err := s.Conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				s.Close()
				return
			}
		}
	}
}
func (s *Socket) SetReadLiveness(limit int64) {
	s.Conn.SetReadLimit(limit)
	_ = s.Conn.SetReadDeadline(time.Now().Add(65 * time.Second))
	s.Conn.SetPongHandler(func(string) error { return s.Conn.SetReadDeadline(time.Now().Add(65 * time.Second)) })
}
