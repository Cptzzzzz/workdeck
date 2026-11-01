package agent

import (
	"sort"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
	"workdeck/internal/protocol"
)

func candidateCategory(c webrtc.ICECandidateStats) string {
	typ := c.CandidateType.String()
	switch typ {
	case "host", "srflx", "prflx", "relay":
	default:
		typ = "unknown"
	}
	network := strings.ToLower(c.Protocol)
	if network != "udp" && network != "tcp" {
		network = "unknown"
	}
	return typ + "/" + network
}

// Only categories and counters leave this function; Pion's addresses, ports,
// candidate identifiers and STUN URLs are never serialized or logged.
func summarizeRTCStats(stats webrtc.StatsReport) (map[string]int, map[string]int, []protocol.RTCNodePair) {
	local := make(map[string]int)
	remote := make(map[string]int)
	keys := make([]string, 0, len(stats))
	for id, stat := range stats {
		keys = append(keys, id)
		if c, ok := stat.(webrtc.ICECandidateStats); ok {
			switch c.Type {
			case webrtc.StatsTypeLocalCandidate:
				local[candidateCategory(c)]++
			case webrtc.StatsTypeRemoteCandidate:
				remote[candidateCategory(c)]++
			}
		}
	}
	sort.Strings(keys)
	pairs := make([]protocol.RTCNodePair, 0)
	for _, id := range keys {
		pair, ok := stats[id].(webrtc.ICECandidatePairStats)
		if !ok {
			continue
		}
		state := string(pair.State)
		switch state {
		case "frozen", "waiting", "in-progress", "failed", "succeeded":
		default:
			state = "unknown"
		}
		left, right := "unknown/unknown", "unknown/unknown"
		if c, ok := stats[pair.LocalCandidateID].(webrtc.ICECandidateStats); ok {
			left = candidateCategory(c)
		}
		if c, ok := stats[pair.RemoteCandidateID].(webrtc.ICECandidateStats); ok {
			right = candidateCategory(c)
		}
		pairs = append(pairs, protocol.RTCNodePair{Local: left, Remote: right, State: state, Count: 1, RequestsSent: pair.RequestsSent, RequestsReceived: pair.RequestsReceived, ResponsesSent: pair.ResponsesSent, ResponsesReceived: pair.ResponsesReceived})
		if len(pairs) == 128 {
			break
		}
	}
	return local, remote, pairs
}

func (l *terminalLink) sampleRTC(peer *webrtc.PeerConnection) {
	started := time.Now()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
		}
		l.mu.Lock()
		if l.closed || l.peer != peer {
			l.mu.Unlock()
			return
		}
		received, applied, rejected, pending := l.remoteCandidateCount, l.remoteApplied, l.remoteRejected, len(l.remoteCandidates)
		wire, sink := l.wire, l.trace
		l.mu.Unlock()
		local, remote, pairs := summarizeRTCStats(peer.GetStats())
		d := &protocol.RTCNodeDiagnostic{SampleMs: time.Since(started).Milliseconds(), Gathering: peer.ICEGatheringState().String(), ICE: peer.ICEConnectionState().String(), Connection: peer.ConnectionState().String(), STUNServers: len(stunURLs()), LocalCandidates: local, RemoteCandidates: remote, RemoteReceived: received, RemoteApplied: applied, RemoteRejected: rejected, RemotePending: pending, Pairs: pairs}
		if wire != nil {
			summary := wire.snapshot()
			d.Wire = &summary
		}
		sink.write("node", nil, d)
		if l.ws.JSON(protocol.Frame{Type: "rtc-diagnostic", NodeDiagnostic: d}) != nil {
			return
		}
		if d.Connection == "connected" || d.Connection == "closed" || d.Connection == "failed" || time.Since(started) >= 30*time.Second {
			return
		}
	}
}
