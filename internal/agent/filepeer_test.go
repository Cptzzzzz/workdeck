package agent

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestFilePeerUsesIndependentReliableChannelsAndLease(t *testing.T) {
	t.Setenv("WORKDECK_STUN_URLS", "")
	t.Setenv("WORKDECK_DIRECT", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	packets := make(chan filePacket, 8)
	answers := make(chan string, 1)
	agent := &filePeer{ctx: ctx, packets: packets, signal: func(_ string, kind string, value any) error {
		if kind == "file.rtc.answer" {
			answers <- value.(map[string]string)["sdp"]
		}
		return nil
	}}
	defer agent.close()
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	control, err := peer.CreateDataChannel("workdeck-file-control", nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := peer.CreateDataChannel("workdeck-file-data", nil)
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan string, 2)
	control.OnOpen(func() { opened <- "control" })
	data.OnOpen(func() { opened <- "data" })
	replies := make(chan webrtc.DataChannelMessage, 2)
	control.OnMessage(func(m webrtc.DataChannelMessage) { replies <- m })
	data.OnMessage(func(m webrtc.DataChannelMessage) { replies <- m })
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathering := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathering:
	case <-time.After(8 * time.Second):
		t.Fatal("offer gathering timed out")
	}
	agent.offer("fixture", peer.LocalDescription().SDP)
	var sdp string
	select {
	case sdp = <-answers:
	case <-time.After(8 * time.Second):
		t.Fatal("answer timed out")
	}
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-opened:
		case <-time.After(8 * time.Second):
			t.Fatal("channels did not open")
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for !agent.available() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !agent.available() {
		t.Fatal("agent channels unavailable")
	}
	payload := bytes.Repeat([]byte{0x62}, 32768)
	if err = control.SendText("control"); err != nil {
		t.Fatal(err)
	}
	if err = data.Send(payload); err != nil {
		t.Fatal(err)
	}
	seenControl, seenData := false, false
	for i := 0; i < 2; i++ {
		select {
		case p := <-packets:
			if p.route != "direct" {
				t.Fatal(p.route)
			}
			if p.kind == websocket.TextMessage && string(p.data) == "control" {
				seenControl = true
			}
			if p.kind == websocket.BinaryMessage && bytes.Equal(p.data, payload) {
				seenData = true
			}
		case <-time.After(5 * time.Second):
			t.Fatal("agent receive timeout")
		}
	}
	if !seenControl || !seenData {
		t.Fatal("separate channels lost a packet")
	}
	if err = agent.write(websocket.TextMessage, []byte("reply")); err != nil {
		t.Fatal(err)
	}
	if err = agent.write(websocket.BinaryMessage, payload); err != nil {
		t.Fatal(err)
	}
	seenControl, seenData = false, false
	for i := 0; i < 2; i++ {
		select {
		case msg := <-replies:
			if msg.IsString && string(msg.Data) == "reply" {
				seenControl = true
			}
			if !msg.IsString && bytes.Equal(msg.Data, payload) {
				seenData = true
			}
		case <-time.After(5 * time.Second):
			t.Fatal("browser receive timeout")
		}
	}
	if !seenControl || !seenData {
		t.Fatal("separate channels lost a reply")
	}
	cancel()
	agent.close()
	if err = agent.write(websocket.TextMessage, []byte("late")); err == nil {
		t.Fatal("closed lease accepted data")
	}
}
