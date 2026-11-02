package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"workdeck/internal/protocol"
)

func TestAlternativeProbeCannotSendTerminalInputUntilPromoted(t *testing.T) {
	t.Setenv("WORKDECK_STUN_URLS", "")
	serverSide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil); err == nil {
			serverSide <- c
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn := <-serverSide
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := &terminalLink{ctx: ctx, cancel: cancel, ws: &protocol.Socket{Conn: conn}, active: "relay", incoming: make(chan linkPacket, 8)}
	defer l.close()
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	channel, err := peer.CreateDataChannel("workdeck-path", nil)
	if err != nil {
		t.Fatal(err)
	}
	open := make(chan struct{})
	channel.OnOpen(func() { close(open) })
	responses := make(chan protocol.Frame, 1)
	channel.OnMessage(func(m webrtc.DataChannelMessage) {
		var f protocol.Frame
		if json.Unmarshal(m.Data, &f) == nil {
			responses <- f
		}
	})
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("offer gathering timed out")
	}
	l.offerAlternative(protocol.Frame{ID: "test", Route: "native", SDP: peer.LocalDescription().SDP})
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	var answer protocol.Frame
	if err = client.ReadJSON(&answer); err != nil || answer.Type != "rtc-path-answer" {
		t.Fatalf("missing answer: %+v %v", answer, err)
	}
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-open:
	case <-time.After(10 * time.Second):
		t.Fatal("probe channel failed to open")
	}
	if err = channel.Send([]byte("terminal input")); err != nil {
		t.Fatal(err)
	}
	if err = channel.SendText(`{"type":"probe","id":"ping"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-responses:
		if reply.Type != "probe-reply" || reply.ID != "ping" {
			t.Fatalf("unexpected response %+v", reply)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no probe response")
	}
	select {
	case <-l.incoming:
		t.Fatal("unpromoted path sent terminal data")
	default:
	}
	l.mu.Lock()
	l.active = "direct"
	l.mu.Unlock()
	l.promoteAlternative("test")
	l.mu.Lock()
	incorrectlyPromoted := l.path == nil || l.path.promoted
	l.active = "relay"
	l.mu.Unlock()
	if incorrectlyPromoted {
		t.Fatal("promoted while the old direct path was active")
	}
	l.promoteAlternative("test")
	var ready protocol.Frame
	if err = client.ReadJSON(&ready); err != nil || ready.Type != "rtc-path-ready" {
		t.Fatalf("missing promotion: %+v %v", ready, err)
	}
	if err = channel.Send([]byte("after promotion")); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-l.incoming:
		if string(p.data) != "after promotion" || p.route != "direct" {
			t.Fatalf("wrong packet: %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("promoted channel did not forward")
	}
}
