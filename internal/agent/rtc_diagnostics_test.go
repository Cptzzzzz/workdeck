package agent

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestRTCStatsAreSummarizedWithoutNetworkIdentity(t *testing.T) {
	stats := webrtc.StatsReport{
		"private-local-id":  webrtc.ICECandidateStats{Type: webrtc.StatsTypeLocalCandidate, CandidateType: webrtc.ICECandidateTypeHost, Protocol: "udp", IP: "192.0.2.19", Port: 54321, URL: "stun:private-host"},
		"private-remote-id": webrtc.ICECandidateStats{Type: webrtc.StatsTypeRemoteCandidate, CandidateType: webrtc.ICECandidateTypeSrflx, Protocol: "udp", IP: "198.51.100.10", Port: 12345},
		"private-pair-id":   webrtc.ICECandidatePairStats{LocalCandidateID: "private-local-id", RemoteCandidateID: "private-remote-id", State: webrtc.StatsICECandidatePairStateInProgress, RequestsSent: 12, ResponsesReceived: 3},
	}
	local, remote, pairs := summarizeRTCStats(stats)
	if local["host/udp"] != 1 || remote["srflx/udp"] != 1 || len(pairs) != 1 || pairs[0].RequestsSent != 12 || pairs[0].ResponsesReceived != 3 {
		t.Fatalf("incorrect ICE summary: %+v %+v %+v", local, remote, pairs)
	}
	data, err := json.Marshal(struct {
		Local  map[string]int
		Remote map[string]int
		Pairs  any
	}{local, remote, pairs})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"192.0.2", "198.51.100", "54321", "12345", "private-", "stun:"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("summary leaks %q", secret)
		}
	}
}
