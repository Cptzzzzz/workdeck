package agent

import (
	"context"
	"os"
	"testing"

	"workdeck/internal/protocol"
)

func TestOrdinaryAgentCannotImpersonateAnotherAccount(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires an ordinary service account")
	}
	if _, err := sessionCommand(context.Background(), protocol.Session{RunUser: "root"}, "/usr/bin/true"); err == nil {
		t.Fatal("unprivileged Agent accepted a different session owner")
	}
	if _, err := managerCommand(context.Background(), protocol.Session{Scope: "system"}, "systemctl", "status", "anything"); err == nil {
		t.Fatal("unprivileged Agent accepted a system-scoped session")
	}
}
