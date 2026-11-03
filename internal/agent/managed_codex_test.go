package agent

import (
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"workdeck/internal/protocol"
)

func TestManagedProxyEnvironment(t *testing.T) {
	base := []string{"PATH=/bin", "http_proxy=http://old", "HTTPS_PROXY=http://old", "ALL_PROXY=http://old", "NO_PROXY=localhost"}
	original := append([]string(nil), base...)
	disabled := proxyEnvironment(base, protocol.CodexLaunchOptions{ProxyMode: "none"})
	if !reflect.DeepEqual(disabled, []string{"PATH=/bin", "NO_PROXY=localhost"}) {
		t.Fatal(disabled)
	}
	custom := proxyEnvironment(base, protocol.CodexLaunchOptions{ProxyMode: "custom", Proxy: "http://local.test:1234"})
	if len(custom) != 8 {
		t.Fatal("expected all six proxy variables")
	}
	if !reflect.DeepEqual(base, original) {
		t.Fatal("modified parent environment")
	}
}

func TestManagedGoalOverridesCompletedChildTurns(t *testing.T) {
	for _, goal := range []string{"active", "complete", "paused", "blocked", "budgetLimited", "usageLimited", ""} {
		t.Run(goal, func(t *testing.T) {
			var calls []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if e != nil {
					return
				}
				defer c.Close()
				for {
					var msg struct {
						ID     int    `json:"id"`
						Method string `json:"method"`
					}
					if c.ReadJSON(&msg) != nil {
						return
					}
					calls = append(calls, msg.Method)
					var result any
					switch msg.Method {
					case "thread/read":
						result = map[string]any{"thread": map[string]any{"status": map[string]any{"type": "idle"}}}
					case "thread/goal/get":
						if goal == "" {
							result = map[string]any{"goal": nil}
						} else {
							result = map[string]any{"goal": map[string]any{"status": goal, "tokensUsed": 100, "createdAt": 123}}
						}
					case "thread/turns/list":
						result = map[string]any{"data": []any{map[string]any{"id": "turn", "status": "completed", "completedAt": 123}}}
					default:
						t.Errorf("observer attempted mutation: %s", msg.Method)
						return
					}
					_ = c.WriteJSON(map[string]any{"id": msg.ID, "result": result})
				}
			}))
			defer server.Close()
			c, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			o, e := sampleManagedCodex(&codexRPC{ws: c}, "parent-thread")
			if e != nil {
				t.Fatal(e)
			}
			statuses := map[string]string{"active": "goal_active", "complete": "goal_complete", "paused": "goal_paused", "blocked": "goal_blocked", "budgetLimited": "goal_budget_limited", "usageLimited": "goal_usage_limited", "": "turn_ended"}
			if o.Status != statuses[goal] || !o.Managed || o.ThreadID != "parent-thread" {
				t.Fatalf("unexpected observation: %+v", o)
			}
			data, _ := json.Marshal(o)
			if strings.Contains(string(data), "objective") {
				t.Fatal("objective must never be serialized")
			}
			if len(calls) != 3 {
				t.Fatal(fmt.Sprint(calls))
			}
		})
	}
}

func TestManagedLaterConversationAfterCompletedGoal(t *testing.T) {
	for _, tc := range []struct {
		name             string
		goal             string
		started, updated int64
		want             string
	}{
		{"later regular turn", "complete", 200, 130, "turn_ended"},
		{"goal completed in this turn", "complete", 120, 130, "goal_complete"},
		{"active goal suppresses child completion", "active", 200, 130, "goal_active"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if e != nil {
					return
				}
				defer c.Close()
				for {
					var msg struct {
						ID     int    `json:"id"`
						Method string `json:"method"`
					}
					if c.ReadJSON(&msg) != nil {
						return
					}
					var result any
					switch msg.Method {
					case "thread/read":
						result = map[string]any{"thread": map[string]any{"status": map[string]any{"type": "idle"}}}
					case "thread/goal/get":
						result = map[string]any{"goal": map[string]any{"status": tc.goal, "createdAt": 100, "updatedAt": tc.updated}}
					case "thread/turns/list":
						result = map[string]any{"data": []any{map[string]any{"id": "fixture-turn", "status": "completed", "startedAt": tc.started, "completedAt": tc.started + 10}}}
					default:
						t.Errorf("unexpected method %s", msg.Method)
						return
					}
					_ = c.WriteJSON(map[string]any{"id": msg.ID, "result": result})
				}
			}))
			defer server.Close()
			c, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			o, e := sampleManagedCodex(&codexRPC{ws: c}, "fixture-thread")
			if e != nil {
				t.Fatal(e)
			}
			if o.Status != tc.want {
				t.Fatalf("status %s, want %s", o.Status, tc.want)
			}
			if tc.name == "later regular turn" {
				if _, kind := protocol.CodexNotice("terminal", &protocol.CodexObservation{Managed: true, ThreadID: o.ThreadID, TurnID: o.TurnID, TurnStartedAt: o.TurnStartedAt, Status: o.Status, Goal: o.Goal, EventID: "event", ObservedAt: "2026-11-03T09:00:00Z"}); kind != "turn_complete" {
					t.Fatal(kind)
				}
			}
		})
	}
}
