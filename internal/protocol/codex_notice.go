package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// CodexNotice identifies a meaningful state change, not every observation.
// Managed Goal completions are deduplicated across token counter updates.
func CodexNotice(terminal string, o *CodexObservation) (key, kind string) {
	if o == nil || o.EventID == "" || o.ObservedAt == "" {
		return "", ""
	}
	identity := ""
	switch o.Status {
	case "goal_complete":
		if !o.Managed || o.Goal == nil || o.Goal.Status != "complete" || o.ThreadID == "" || o.Goal.CreatedAt <= 0 {
			return "", ""
		}
		kind, identity = "goal_complete", fmt.Sprintf("%s:%d", o.ThreadID, o.Goal.CreatedAt)
	case "turn_ended":
		if o.Goal != nil || o.Managed && o.TurnID == "" {
			return "", ""
		}
		if o.Managed {
			kind = "turn_complete"
			identity = o.ThreadID + ":" + o.TurnID
		} else {
			kind = "turn_possible"
			// Hooks do not always provide a turn ID and cannot prove Goal completion.
			identity = o.EventID
		}
	case "attention", "goal_paused", "goal_blocked", "goal_budget_limited", "goal_usage_limited", "interrupted":
		kind, identity = o.Status, o.EventID
	default:
		return "", ""
	}
	h := sha256.Sum256([]byte(terminal + "\x00" + kind + "\x00" + identity))
	return hex.EncodeToString(h[:]), kind
}
