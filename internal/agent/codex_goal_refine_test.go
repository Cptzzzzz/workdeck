package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

func testTurnUUID(seconds int64) string {
	ms := seconds * 1000
	return fmt.Sprintf("%08x-%04x-7000-8000-000000000001", ms>>16, ms&0xffff)
}

func TestManagedLegacyGoalIsRefinedAndNoticeRequeued(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	runtime, e := os.MkdirTemp(tmp, "workdeck-codex-")
	if e != nil {
		t.Fatal(e)
	}
	controlDir := filepath.Join(tmp, "control")
	if e = os.Mkdir(controlDir, 0700); e != nil {
		t.Fatal(e)
	}
	controlSocket := filepath.Join(controlDir, "socket")
	listener, e := net.Listen("unix", controlSocket)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(controlSocket, filepath.Join(runtime, "rpc.sock")); e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer conn.Close()
		for {
			var v struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
			}
			if conn.ReadJSON(&v) != nil {
				return
			}
			if v.ID == 0 {
				continue
			}
			var result any
			switch v.Method {
			case "initialize":
				result = map[string]any{}
			case "thread/loaded/list":
				result = map[string]any{"data": []string{"fixture-thread"}}
			case "thread/goal/get":
				result = map[string]any{"goal": map[string]any{"status": "complete", "createdAt": 100, "updatedAt": 130, "objective": "private objective"}}
			default:
				t.Errorf("unexpected RPC method %s", v.Method)
				return
			}
			_ = conn.WriteJSON(map[string]any{"id": v.ID, "result": result})
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	dir := filepath.Join(tmp, "agent")
	id := strings.Repeat("a", 48)
	if e = os.MkdirAll(filepath.Join(dir, "sessions"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = atomicJSON(filepath.Join(dir, "sessions", id+".json"), protocol.Session{ID: id}); e != nil {
		t.Fatal(e)
	}
	a := &Agent{sessions: &Sessions{dir: dir}}
	old := &protocol.CodexObservation{Managed: true, ThreadID: "fixture-thread", TurnID: testTurnUUID(200), Status: "goal_complete", EventID: "event", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Goal: &protocol.CodexGoal{Status: "complete", CreatedAt: 100}}
	refined := a.refineManagedGoal(id, old)
	if refined.Status != "turn_ended" || refined.TurnStartedAt != 200 || refined.Goal.UpdatedAt != 130 {
		t.Fatalf("historical goal still active: %+v", refined)
	}
	if b, _ := json.Marshal(refined); strings.Contains(string(b), "private objective") {
		t.Fatal("objective leaked")
	}
	if _, kind := protocol.CodexNotice(id, refined); kind != "turn_complete" {
		t.Fatal("ordinary turn not notified", kind)
	}
	actual := *old
	actual.EventID = "new-event"
	actual.TurnID = testTurnUUID(120)
	if got := a.refineManagedGoal(id, &actual); got.Status != "goal_complete" {
		t.Fatal("real Goal completion lost", got.Status)
	}

	previous := protocol.CodexObservation{Status: "running", Managed: true}
	if !spoolCodexNotice(dir, id, *old, previous) {
		t.Fatal("spooling failed")
	}
	received := make(chan protocol.Message, 1)
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer c.Close()
		var msg protocol.Message
		if c.ReadJSON(&msg) == nil {
			received <- msg
		}
	}))
	defer control.Close()
	conn, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(control.URL, "http"), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.sendCodexNotices(ctx, &protocol.Socket{Conn: conn})
	select {
	case msg := <-received:
		_, kind := protocol.CodexNotice(id, msg.Codex)
		if kind != "turn_complete" || msg.Codex.TurnStartedAt != 200 || msg.Codex.Goal.UpdatedAt != 130 {
			t.Fatal("wrong notification", kind)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("corrected notice was not transmitted")
	}
}

func TestUUIDTurnStartFallback(t *testing.T) {
	if got := turnStartFromUUID(testTurnUUID(200)); got != 200 {
		t.Fatal(got)
	}
	for _, v := range []string{"", "12345678-0000-4000-8000-000000000001", "zzz45678-0000-7000-8000-000000000001"} {
		if turnStartFromUUID(v) != 0 {
			t.Fatal("accepted malformed ID", v)
		}
	}
}

// Opt in only for a read-only check of the currently attached managed session.
func TestLiveManagedHistoricalGoalMetadata(t *testing.T) {
	if os.Getenv("WORKDECK_LIVE_GOAL_TEST") != "1" {
		t.Skip("live managed session check not requested")
	}
	name := filepath.Base(strings.SplitN(os.Getenv("TMUX"), ",", 2)[0])
	id := strings.TrimPrefix(name, "workdeck-")
	if !validID(id) {
		t.Skip("not in a Workdeck terminal")
	}
	dir := filepath.Join(os.Getenv("HOME"), ".local/share/workdeck")
	b, err := os.ReadFile(codexEventPath(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	var obs protocol.CodexObservation
	if err = json.Unmarshal(b, &obs); err != nil {
		t.Fatal(err)
	}
	if !obs.Managed || obs.Goal == nil || obs.Goal.Status != "complete" {
		t.Skip("no historical completed Goal")
	}
	obs.Status = "goal_complete"
	obs.Goal.UpdatedAt = 0
	obs.TurnStartedAt = 0
	a := &Agent{sessions: &Sessions{dir: dir}}
	result := a.refineManagedGoal(id, &obs)
	if result.Status != "turn_ended" || result.TurnStartedAt <= result.Goal.UpdatedAt {
		t.Fatalf("historical Goal was not refined: %s", result.Status)
	}
	t.Log("Current app-server classified the ordinary turn without changing the session.")
}
