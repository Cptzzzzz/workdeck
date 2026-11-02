package hub

import (
	"context"
	"encoding/json"
	"time"
	"workdeck/internal/protocol"
)

// Probe-only browser transports reuse an authorized viewer's node channel.
// They cannot create a PTY, resize a session, take ownership, or send input.
func (h *Hub) serveTerminalProbe(ctx context.Context, browser browserPeer, l login, terminal string) {
	h.mu.Lock()
	var target *attachment
	for _, a := range h.attachments {
		if a.terminalID == terminal && a.loginHash == l.Hash && a.agent != nil {
			target = a
			break
		}
	}
	h.mu.Unlock()
	if target == nil {
		_ = browser.JSON(protocol.Frame{Type: "error", Message: "请先打开此终端，再测试链路"})
		return
	}
	done := make(chan struct{})
	defer close(done)
	timeout := time.NewTimer(25 * time.Second)
	defer timeout.Stop()
	go func() {
		select {
		case <-ctx.Done():
		case <-target.done:
		case <-timeout.C:
		case <-done:
			return
		}
		browser.Close()
	}()
	if browser.JSON(protocol.Frame{Type: "ready", ReadOnly: true}) != nil {
		return
	}
	for i := 0; i < 6; i++ {
		kind, data, err := browser.ReadMessage()
		if err != nil || kind != 1 {
			return
		}
		var frame protocol.Frame
		if json.Unmarshal(data, &frame) != nil || frame.Type != "probe" || len(frame.ID) > 64 || frame.ID == "" {
			return
		}
		id := randomID()
		reply := make(chan protocol.Frame, 1)
		h.mu.Lock()
		if target.testProbes == nil {
			target.testProbes = map[string]chan protocol.Frame{}
		}
		target.testProbes[id] = reply
		h.mu.Unlock()
		err = target.agent.JSON(protocol.Frame{Type: "probe", ID: id, Padding: "diagnostic"})
		if err == nil {
			select {
			case <-reply:
				err = browser.JSON(protocol.Frame{Type: "probe-reply", ID: frame.ID})
			case <-time.After(2 * time.Second):
			case <-target.done:
				err = context.Canceled
			case <-ctx.Done():
				err = ctx.Err()
			}
		}
		h.mu.Lock()
		delete(target.testProbes, id)
		h.mu.Unlock()
		if err != nil {
			return
		}
	}
}
