package agent

import (
	"strings"
	"testing"
	"workdeck/internal/protocol"
)

func TestRemoteCandidatesQueueUntilDescriptionAndRemainBounded(t *testing.T) {
	link := &terminalLink{offered: true}
	link.addRemoteCandidate(protocol.ICECandidate{Candidate: strings.Repeat("x", 2049)})
	if len(link.remoteCandidates) != 0 {
		t.Fatal("oversized candidate accepted")
	}
	for i := 0; i < 150; i++ {
		link.addRemoteCandidate(protocol.ICECandidate{Candidate: "candidate:1 1 udp 1 192.0.2.1 1234 typ host"})
	}
	if len(link.remoteCandidates) != 128 || link.remoteCandidateCount != 128 {
		t.Fatalf("candidate queue is not bounded: %d", len(link.remoteCandidates))
	}
	link.closed = true
	link.addRemoteCandidate(protocol.ICECandidate{Candidate: "candidate:2"})
	if len(link.remoteCandidates) != 128 {
		t.Fatal("closed link accepted candidate")
	}
}
