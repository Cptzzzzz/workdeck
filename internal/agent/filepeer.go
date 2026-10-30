package agent

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"workdeck/internal/fileprotocol"
)

type filePacket struct {
	route string
	kind  int
	data  []byte
}

// filePeer is tied to the authenticated file WebSocket lease. It transports
// no terminal data and is destroyed whenever that lease ends.
type filePeer struct {
	ctx             context.Context
	packets         chan<- filePacket
	signal          func(string, string, any) error
	mu              sync.Mutex
	peer            *webrtc.PeerConnection
	control, data   *webrtc.DataChannel
	offered, closed bool
}

func (p *filePeer) available() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.closed && p.ctx.Err() == nil && p.control != nil && p.data != nil && p.control.ReadyState() == webrtc.DataChannelStateOpen && p.data.ReadyState() == webrtc.DataChannelStateOpen
}
func (p *filePeer) close() {
	p.mu.Lock()
	p.closed = true
	peer := p.peer
	p.mu.Unlock()
	if peer != nil {
		_ = peer.Close()
	}
}
func (p *filePeer) offer(id, sdp string) {
	p.mu.Lock()
	if p.closed || p.offered || p.ctx.Err() != nil || os.Getenv("WORKDECK_DIRECT") == "0" || len(sdp) == 0 || len(sdp) > 22000 {
		p.mu.Unlock()
		return
	}
	p.offered = true
	p.mu.Unlock()
	go func() {
		if err := p.answer(id, sdp); err != nil && p.ctx.Err() == nil {
			_ = p.signal(id, "file.rtc.unavailable", nil)
		}
	}()
}
func (p *filePeer) answer(id, sdp string) error {
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
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
	p.mu.Lock()
	if p.closed || p.ctx.Err() != nil {
		p.mu.Unlock()
		_ = peer.Close()
		return context.Canceled
	}
	p.peer = peer
	p.mu.Unlock()
	success := false
	defer func() {
		if !success {
			_ = peer.Close()
		}
	}()
	peer.OnDataChannel(func(ch *webrtc.DataChannel) {
		p.mu.Lock()
		valid := !p.closed && ch.Ordered() && ch.MaxRetransmits() == nil && ch.MaxPacketLifeTime() == nil
		switch ch.Label() {
		case "workdeck-file-control":
			if p.control != nil {
				valid = false
			} else if valid {
				p.control = ch
			}
		case "workdeck-file-data":
			if p.data != nil {
				valid = false
			} else if valid {
				p.data = ch
			}
		default:
			valid = false
		}
		p.mu.Unlock()
		if !valid {
			_ = ch.Close()
			return
		}
		ch.OnMessage(func(msg webrtc.DataChannelMessage) {
			kind := websocket.BinaryMessage
			if msg.IsString {
				kind = websocket.TextMessage
			}
			if (ch.Label() == "workdeck-file-control" && (kind != websocket.TextMessage || len(msg.Data) > fileprotocol.MaxControl)) || (ch.Label() == "workdeck-file-data" && (kind != websocket.BinaryMessage || len(msg.Data) > fileprotocol.HeaderSize+fileprotocol.MaxChunk)) {
				go peer.Close()
				return
			}
			packet := filePacket{route: "direct", kind: kind, data: append([]byte(nil), msg.Data...)}
			select {
			case p.packets <- packet:
			case <-p.ctx.Done():
			default:
				go peer.Close()
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
	case <-p.ctx.Done():
		return p.ctx.Err()
	}
	if peer.LocalDescription() == nil {
		return errors.New("file peer has no local description")
	}
	if err = p.signal(id, "file.rtc.answer", map[string]string{"sdp": peer.LocalDescription().SDP}); err != nil {
		return err
	}
	success = true
	return nil
}
func (p *filePeer) write(kind int, data []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.ctx.Err() != nil {
		return context.Canceled
	}
	ch := p.control
	limit := fileprotocol.MaxControl
	if kind == websocket.BinaryMessage {
		ch = p.data
		limit = fileprotocol.HeaderSize + fileprotocol.MaxChunk
	}
	if ch == nil || ch.ReadyState() != webrtc.DataChannelStateOpen || len(data) > limit || ch.BufferedAmount()+uint64(len(data)) > 256<<10 {
		return errors.New("file direct channel unavailable or congested")
	}
	if kind == websocket.TextMessage {
		return ch.SendText(string(data))
	}
	return ch.Send(data)
}
