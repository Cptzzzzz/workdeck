package hub

import (
	"github.com/gorilla/websocket"
	"net/http"
	"sync"
	"workdeck/internal/protocol"
)

type warmSocket struct {
	socket               *protocol.Socket
	ready, dead, release chan struct{}
	once                 sync.Once
}

func (s *warmSocket) releaseOnce() { s.once.Do(func() { close(s.release) }) }
func (h *Hub) claimWarm(a *agentConn) *warmSocket {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.agents[a.nodeID] != a {
		return nil
	}
	for len(a.warm) > 0 {
		s := a.warm[0]
		a.warm = a.warm[1:]
		select {
		case <-s.dead:
			continue
		default:
			return s
		}
	}
	return nil
}
func (h *Hub) standbySocket(w http.ResponseWriter, r *http.Request) {
	node, ok := h.agentIdentity(r)
	if !ok {
		failure(w, 401, "节点认证失败")
		return
	}
	conn, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	socket := &protocol.Socket{Conn: conn}
	socket.SetReadLiveness(65536)
	defer socket.Close()
	s := &warmSocket{socket: socket, ready: make(chan struct{}), dead: make(chan struct{}), release: make(chan struct{})}
	defer close(s.dead)
	h.mu.Lock()
	a := h.agents[node]
	if a == nil || a.done == nil || len(a.warm) >= 2 {
		h.mu.Unlock()
		return
	}
	a.warm = append(a.warm, s)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		for i, v := range a.warm {
			if v == s {
				a.warm = append(a.warm[:i], a.warm[i+1:]...)
				break
			}
		}
	}()
	idleDone := make(chan struct{})
	var stopHeartbeat sync.Once
	stopIdle := func() { stopHeartbeat.Do(func() { close(idleDone) }) }
	defer stopIdle()
	go socket.Heartbeat(idleDone)
	go func() {
		select {
		case <-a.done:
			socket.Close()
		case <-s.dead:
		}
	}()
	var msg protocol.Message
	if conn.ReadJSON(&msg) != nil || msg.Type != "standby.bound" {
		return
	}
	stopIdle()
	close(s.ready)
	// The idle reader has finished before the terminal forwarding reader starts.
	// HTTP owns the upgraded connection until the borrowing viewer releases it.
	select {
	case <-s.release:
	case <-a.done:
	}
}
