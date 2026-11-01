package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/transport/v5/stdnet"
	"github.com/pion/webrtc/v4"
	"workdeck/internal/protocol"
)

type linkPacket struct {
	route string
	kind  int
	data  []byte
}

type routeChange struct {
	id, target string
	done       chan struct{}
}

// terminalLink keeps the authenticated relay alive as the authorization lease.
// An optional peer transports bytes for this attachment, never a new shell.
type terminalLink struct {
	ctx                  context.Context
	cancel               context.CancelFunc
	ws                   *protocol.Socket
	incoming             chan linkPacket
	mu                   sync.Mutex
	active               string
	pending              *routeChange
	peer                 *webrtc.PeerConnection
	direct               *webrtc.DataChannel
	offered, closed      bool
	remoteReady          bool
	remoteCandidates     []webrtc.ICECandidateInit
	remoteCandidateCount int
	remoteApplied        int
	remoteRejected       int
	traceDir             string
	trace                *rtcTraceSink
	wire                 *iceWireTrace
}

func stunURLs() []string {
	value, exists := os.LookupEnv("WORKDECK_STUN_URLS")
	if !exists {
		value = "stun:stun.cloudflare.com:3478"
	}
	urls := []string{}
	for _, value := range strings.Split(value, ",") {
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "stun:") && len(value) < 256 {
			urls = append(urls, value)
		}
		if len(urls) == 4 {
			break
		}
	}
	return urls
}

func newTerminalLink(ctx context.Context, cancel context.CancelFunc, ws *protocol.Socket, dirs ...string) *terminalLink {
	l := &terminalLink{ctx: ctx, cancel: cancel, ws: ws, active: "relay", incoming: make(chan linkPacket, 64)}
	if len(dirs) > 0 {
		l.traceDir = dirs[0]
	}
	go func() {
		for {
			kind, data, err := ws.Conn.ReadMessage()
			if err != nil {
				cancel()
				return
			}
			if !l.receive(linkPacket{"relay", kind, data}) {
				return
			}
		}
	}()
	if os.Getenv("WORKDECK_DIRECT") != "0" {
		_ = ws.JSON(protocol.Frame{Type: "rtc-config", ICEServers: stunURLs(), RTCTrickle: true, RTCTraceAvailable: rtcTraceEnabled(l.traceDir)})
	}
	return l
}

func (l *terminalLink) receive(packet linkPacket) bool {
	if len(packet.data) > 65536 {
		l.cancel()
		return false
	}
	select {
	case l.incoming <- packet:
		return true
	case <-l.ctx.Done():
		return false
	}
}

func (l *terminalLink) close() {
	l.mu.Lock()
	l.closed = true
	peer := l.peer
	sink := l.trace
	l.mu.Unlock()
	if peer != nil {
		_ = peer.Close()
	}
	sink.close()
}

func (l *terminalLink) writeLocked(route string, kind int, data []byte) error {
	if l.closed || l.ctx.Err() != nil {
		return context.Canceled
	}
	if route == "relay" {
		return l.ws.Write(kind, data)
	}
	if l.direct == nil || l.direct.ReadyState() != webrtc.DataChannelStateOpen {
		return errors.New("direct channel unavailable")
	}
	if l.direct.BufferedAmount() > 1<<20 {
		return errors.New("direct channel congested")
	}
	if kind == websocket.TextMessage {
		return l.direct.SendText(string(data))
	}
	return l.direct.Send(data)
}

func (l *terminalLink) jsonLocked(route string, frame protocol.Frame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return l.writeLocked(route, websocket.TextMessage, data)
}

func (l *terminalLink) write(kind int, data []byte) error {
	for {
		l.mu.Lock()
		if l.pending == nil {
			err := l.writeLocked(l.active, kind, data)
			l.mu.Unlock()
			return err
		}
		done := l.pending.done
		l.mu.Unlock()
		select {
		case <-done:
		case <-l.ctx.Done():
			return l.ctx.Err()
		}
	}
}

func (l *terminalLink) accepts(route string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ctx.Err() == nil && !l.closed && l.pending == nil && l.active == route
}

func (a *Agent) isController(msg protocol.Message) bool {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	return !msg.ReadOnly && msg.Ticket != "" && a.controllers[msg.TerminalID] == msg.Ticket
}

// The ready frame is an output fence on the old ordered channel. Output pauses
// until commit arrives on the target channel, preventing cross-path reordering.
func (l *terminalLink) requestRoute(source string, frame protocol.Frame) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if frame.ID == "" || len(frame.ID) > 64 || source != l.active || l.pending != nil || (frame.Route != "direct" && frame.Route != "relay") {
		return nil
	}
	if frame.Route == "direct" && (l.direct == nil || l.direct.ReadyState() != webrtc.DataChannelStateOpen) {
		return nil
	}
	change := &routeChange{frame.ID, frame.Route, make(chan struct{})}
	l.pending = change
	err := l.jsonLocked(source, protocol.Frame{Type: "route-ready", ID: change.id, Route: change.target})
	go func() {
		select {
		case <-change.done:
		case <-l.ctx.Done():
		case <-time.After(4 * time.Second):
			l.cancel()
		}
	}()
	return err
}

func (l *terminalLink) commitRoute(source string, frame protocol.Frame) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	change := l.pending
	if change == nil || frame.ID != change.id || source != change.target {
		return nil
	}
	if err := l.jsonLocked(source, protocol.Frame{Type: "route-active", ID: change.id, Route: change.target}); err != nil {
		return err
	}
	l.active = change.target
	l.pending = nil
	close(change.done)
	return nil
}

func (l *terminalLink) probe(source string, frame protocol.Frame) error {
	if len(frame.ID) > 64 || len(frame.Padding) > 1024 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	err := l.jsonLocked(source, protocol.Frame{Type: "probe-reply", ID: frame.ID, Padding: frame.Padding})
	// A failed speculative probe must never detach a healthy relay terminal.
	if source == "direct" && l.active == "relay" && l.pending == nil {
		return nil
	}
	return err
}

func (l *terminalLink) addRemoteCandidate(c protocol.ICECandidate) {
	if len(c.Candidate) > 2048 || (c.SDPMid != nil && len(*c.SDPMid) > 256) || (c.UsernameFragment != nil && len(*c.UsernameFragment) > 256) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.offered || l.closed || l.remoteCandidateCount >= 128 {
		return
	}
	l.remoteCandidateCount++
	candidate := webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment}
	if !l.remoteReady || l.peer == nil {
		l.remoteCandidates = append(l.remoteCandidates, candidate)
		return
	}
	if err := l.peer.AddICECandidate(candidate); err != nil {
		l.remoteRejected++
	} else {
		l.remoteApplied++
	}
}

func (l *terminalLink) negotiate(sdp string, trickle bool, diagnostics bool, trace bool) {
	l.mu.Lock()
	if l.offered || l.closed || os.Getenv("WORKDECK_DIRECT") == "0" || len(sdp) > 60000 {
		l.mu.Unlock()
		return
	}
	l.offered = true
	if trace && diagnostics {
		l.trace = openRTCTrace(l.traceDir)
	}
	l.mu.Unlock()
	go func() {
		if err := l.answer(sdp, trickle, diagnostics); err != nil && l.ctx.Err() == nil {
			_ = l.ws.JSON(protocol.Frame{Type: "rtc-unavailable"})
		}
	}()
}

func (l *terminalLink) answer(sdp string, trickle bool, diagnostics bool) error {
	settings := webrtc.SettingEngine{}
	l.mu.Lock()
	if l.trace != nil {
		if network, err := stdnet.NewNet(); err == nil {
			l.wire = &iceWireTrace{}
			settings.SetNet(&iceTraceNet{Net: network, trace: l.wire})
		}
	}
	l.mu.Unlock()
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
	l.mu.Lock()
	if l.closed || l.ctx.Err() != nil {
		l.mu.Unlock()
		_ = peer.Close()
		return context.Canceled
	}
	l.peer = peer
	l.mu.Unlock()
	succeeded := false
	defer func() {
		if !succeeded {
			_ = peer.Close()
		}
	}()
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		l.mu.Lock()
		if l.direct != nil || channel.Label() != "workdeck" || !channel.Ordered() || channel.MaxRetransmits() != nil || channel.MaxPacketLifeTime() != nil {
			l.mu.Unlock()
			_ = channel.Close()
			return
		}
		l.direct = channel
		l.mu.Unlock()
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			kind := websocket.BinaryMessage
			if message.IsString {
				kind = websocket.TextMessage
			}
			l.receive(linkPacket{"direct", kind, message.Data})
		})
		channel.OnClose(func() {
			l.mu.Lock()
			needed := l.active == "direct" || l.pending != nil
			l.mu.Unlock()
			if needed {
				l.cancel()
			}
		})
	})
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	l.mu.Lock()
	for _, candidate := range l.remoteCandidates {
		if err := peer.AddICECandidate(candidate); err != nil {
			l.remoteRejected++
		} else {
			l.remoteApplied++
		}
	}
	l.remoteCandidates = nil
	l.remoteReady = true
	l.mu.Unlock()
	var candidateMu sync.Mutex
	var pending []protocol.ICECandidate
	answerSent := false
	if trickle {
		peer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			var init webrtc.ICECandidateInit
			if candidate != nil {
				init = candidate.ToJSON()
			}
			c := protocol.ICECandidate{Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex, UsernameFragment: init.UsernameFragment}
			candidateMu.Lock()
			defer candidateMu.Unlock()
			if l.ctx.Err() != nil {
				return
			}
			if !answerSent {
				pending = append(pending, c)
				return
			}
			_ = l.ws.JSON(protocol.Frame{Type: "rtc-candidate", Candidate: &c})
		})
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(answer); err != nil {
		return err
	}
	if !trickle {
		select {
		case <-gathered:
		case <-time.After(5 * time.Second): // Existing host candidates can still work.
		case <-l.ctx.Done():
			return l.ctx.Err()
		}
	}
	if l.ctx.Err() != nil {
		return l.ctx.Err()
	}
	candidateMu.Lock()
	err = l.ws.JSON(protocol.Frame{Type: "rtc-answer", SDP: peer.LocalDescription().SDP})
	if err == nil && trickle {
		answerSent = true
		for _, c := range pending {
			if err = l.ws.JSON(protocol.Frame{Type: "rtc-candidate", Candidate: &c}); err != nil {
				break
			}
		}
		pending = nil
	}
	candidateMu.Unlock()
	succeeded = err == nil
	if succeeded && diagnostics {
		go l.sampleRTC(peer)
	}
	return err
}
