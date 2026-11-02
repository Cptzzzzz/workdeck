package agent

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"workdeck/internal/protocol"
)

// alternativePath is scoped to the same authenticated attachment as the
// terminal. Until promotion it can only answer small latency probes.
type alternativePath struct {
	id       string
	peer     *webrtc.PeerConnection
	channel  *webrtc.DataChannel
	promoted bool // protected by terminalLink.mu
}

func (p *alternativePath) close() {
	if p != nil && p.peer != nil {
		_ = p.peer.Close()
	}
}

func tailnetInterface(name string) bool {
	return name == "tailscale0" || strings.HasPrefix(name, "tailscale")
}

func (l *terminalLink) closeAlternative(id string) {
	l.mu.Lock()
	p := l.path
	if p == nil || p.id != id {
		l.mu.Unlock()
		return
	}
	l.path = nil
	l.mu.Unlock()
	p.close()
}

func (l *terminalLink) offerAlternative(frame protocol.Frame) {
	if frame.ID == "" || len(frame.ID) > 64 || len(frame.SDP) == 0 || len(frame.SDP) > 60000 || (frame.Route != "native" && frame.Route != "tailnet") {
		return
	}
	l.mu.Lock()
	if time.Since(l.pathWindow) >= time.Minute {
		l.pathAttempts = 0
		l.pathWindow = time.Now()
	}
	if l.closed || l.ctx.Err() != nil || l.path != nil || l.pathAttempts >= 4 {
		l.mu.Unlock()
		return
	}
	l.pathAttempts++
	p := &alternativePath{id: frame.ID}
	l.path = p
	l.mu.Unlock()
	go func() {
		if err := l.answerAlternative(p, frame.SDP, frame.Route); err != nil {
			l.closeAlternative(p.id)
			if l.ctx.Err() == nil {
				_ = l.ws.JSON(protocol.Frame{Type: "rtc-path-unavailable", ID: p.id})
			}
		}
	}()
	go func() {
		select {
		case <-time.After(45 * time.Second):
			l.closeAlternative(p.id)
		case <-l.ctx.Done():
		}
	}()
}

func (l *terminalLink) answerAlternative(p *alternativePath, sdp, mode string) error {
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	settings.SetInterfaceFilter(func(name string) bool {
		if mode == "tailnet" {
			return tailnetInterface(name)
		}
		return !tailnetInterface(name)
	})
	settings.SetSCTPMaxMessageSize(65536)
	settings.SetSCTPMaxReceiveBufferSize(1 << 20)
	settings.SetICETimeouts(5*time.Second, 12*time.Second, 2*time.Second)
	config := webrtc.Configuration{}
	if urls := stunURLs(); len(urls) > 0 {
		config.ICEServers = []webrtc.ICEServer{{URLs: urls}}
	}
	peer, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(config)
	if err != nil {
		return err
	}
	l.mu.Lock()
	if l.path != p || l.closed {
		l.mu.Unlock()
		_ = peer.Close()
		return nil
	}
	p.peer = peer
	l.mu.Unlock()
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		l.mu.Lock()
		if l.path != p || p.channel != nil || channel.Label() != "workdeck-path" || !channel.Ordered() || channel.MaxRetransmits() != nil || channel.MaxPacketLifeTime() != nil {
			l.mu.Unlock()
			_ = channel.Close()
			return
		}
		p.channel = channel
		l.mu.Unlock()
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			l.mu.Lock()
			promoted := p.promoted && l.direct == channel
			pending := l.path == p
			l.mu.Unlock()
			if promoted {
				kind := websocket.BinaryMessage
				if message.IsString {
					kind = websocket.TextMessage
				}
				l.receive(linkPacket{"direct", kind, message.Data})
				return
			}
			if !pending || !message.IsString || len(message.Data) > 1400 {
				return
			}
			var frame protocol.Frame
			if json.Unmarshal(message.Data, &frame) != nil || frame.Type != "probe" || frame.ID == "" || len(frame.ID) > 64 || len(frame.Padding) > 1024 {
				return
			}
			if data, err := json.Marshal(protocol.Frame{Type: "probe-reply", ID: frame.ID, Padding: frame.Padding}); err == nil {
				_ = channel.SendText(string(data))
			}
		})
		channel.OnClose(func() {
			l.mu.Lock()
			needed := p.promoted && l.direct == channel && (l.active == "direct" || l.pending != nil)
			l.mu.Unlock()
			if needed {
				l.cancel()
			}
		})
	})
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(answer); err != nil {
		return err
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
	case <-l.ctx.Done():
		return l.ctx.Err()
	}
	l.mu.Lock()
	current := l.path == p && !l.closed
	l.mu.Unlock()
	if !current {
		return nil
	}
	return l.ws.JSON(protocol.Frame{Type: "rtc-path-answer", ID: p.id, SDP: peer.LocalDescription().SDP})
}

// Promotion is allowed only while terminal bytes travel on the relay. The
// ordinary ordered route fence is still required before sending terminal data.
func (l *terminalLink) promoteAlternative(id string) {
	l.mu.Lock()
	p := l.path
	if p == nil || p.id != id || p.channel == nil || p.channel.ReadyState() != webrtc.DataChannelStateOpen || l.closed || l.active != "relay" || l.pending != nil {
		l.mu.Unlock()
		return
	}
	old := l.peer
	l.peer, l.direct, l.path = p.peer, p.channel, nil
	p.promoted = true
	_ = l.ws.JSON(protocol.Frame{Type: "rtc-path-ready", ID: id})
	l.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
}
