package hub

import "testing"

func TestICETraceRequiresUniqueWindowsLogin(t *testing.T) {
	a := &attachment{nodeID: "node-a", loginHash: "login-a", windows: true}
	same := &attachment{nodeID: "node-a", loginHash: "login-a", windows: true}
	mac := &attachment{nodeID: "node-a", loginHash: "login-mac"}
	otherNode := &attachment{nodeID: "node-b", loginHash: "login-b", windows: true}
	h := &Hub{attachments: map[string]*attachment{"a": a, "same": same, "mac": mac, "elsewhere": otherNode}}
	if !h.allowWindowsRTCTrace(a) {
		t.Fatal("same login or other node should not block trace")
	}
	if h.allowWindowsRTCTrace(mac) {
		t.Fatal("non-Windows attachment accepted")
	}
	h.attachments["other"] = &attachment{nodeID: "node-a", loginHash: "login-b", windows: true}
	if h.allowWindowsRTCTrace(a) {
		t.Fatal("ambiguous Windows logins accepted")
	}
}
