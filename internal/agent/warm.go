package agent

import (
	"context"
	"sync"
	"time"
	"workdeck/internal/protocol"
)

// Two workers keep idle authenticated transports ready. Binding a transport
// starts a viewer job, then immediately replenishes that idle slot.
func (a *Agent) warmLoop(ctx context.Context, jobs *sync.WaitGroup) {
	for ctx.Err() == nil {
		socket, err := a.dial("/api/agent/standby", "")
		if err == nil {
			idleDone := make(chan struct{})
			go socket.Heartbeat(idleDone)
			go func() {
				select {
				case <-ctx.Done():
					socket.Close()
				case <-idleDone:
				}
			}()
			var msg protocol.Message
			err = socket.Conn.ReadJSON(&msg)
			close(idleDone)
			if err == nil && msg.Type == "attach" && validID(msg.TerminalID) && msg.Ticket != "" && ctx.Err() == nil {
				// Ownership is ordered on the control socket, never on racing
				// pooled sockets. Wait for that claim before acknowledging a bind.
				deadline := time.Now().Add(time.Second)
				for !msg.ReadOnly && !a.isController(msg) && ctx.Err() == nil && time.Now().Before(deadline) {
					select {
					case <-ctx.Done():
					case <-time.After(time.Millisecond):
					}
				}
				if !msg.ReadOnly && !a.isController(msg) {
					socket.Close()
					continue
				}

				if socket.JSON(protocol.Message{Type: "standby.bound"}) == nil {
					jobs.Add(1)
					go func() { defer jobs.Done(); defer socket.Close(); _ = a.attachSocket(ctx, msg, socket) }()
					continue
				}
			}
			socket.Close()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
