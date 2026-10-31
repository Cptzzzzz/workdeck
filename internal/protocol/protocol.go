package protocol

import "workdeck/internal/files"

// Session is metadata only. The live process and terminal screen remain on the node.
type Session struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Cwd       string            `json:"cwd"`
	State     string            `json:"state"`
	Error     string            `json:"error,omitempty"`
	ExitCode  *int              `json:"exit_code,omitempty"`
	CreatedAt string            `json:"created_at"`
	BootID    string            `json:"boot_id,omitempty"`
	RunUser   string            `json:"run_user,omitempty"`
	Scope     string            `json:"scope,omitempty"`
	Codex     *CodexObservation `json:"codex,omitempty"`
	PanePID   int               `json:"-"`
}

// CodexObservation contains no prompts or model output. A completion records
// one turn, not whether the user's overall objective was achieved.
type CodexObservation struct {
	TurnID        string `json:"turn_id,omitempty"`
	CompletedAt   string `json:"completed_at,omitempty"`
	LaunchCommand string `json:"launch_command,omitempty"`
	Status        string `json:"status,omitempty"`
	EventID       string `json:"event_id,omitempty"`
	ObservedAt    string `json:"observed_at,omitempty"`
	Detected      *bool  `json:"detected,omitempty"`
	ProcessKey    string `json:"process_key,omitempty"`
}

type Directory struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type DirectoryListing struct {
	Path      string      `json:"path"`
	Parent    string      `json:"parent"`
	Entries   []Directory `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type Message struct {
	RunUser       string            `json:"run_user,omitempty"`
	Type          string            `json:"type"`
	RequestID     string            `json:"request_id,omitempty"`
	TerminalID    string            `json:"terminal_id,omitempty"`
	Session       *Session          `json:"session,omitempty"`
	Sessions      []Session         `json:"sessions,omitempty"`
	Error         string            `json:"error,omitempty"`
	Ticket        string            `json:"ticket,omitempty"`
	ReadOnly      bool              `json:"readonly,omitempty"`
	Cols          uint16            `json:"cols,omitempty"`
	Rows          uint16            `json:"rows,omitempty"`
	Hostname      string            `json:"hostname,omitempty"`
	Platform      string            `json:"platform,omitempty"`
	Home          string            `json:"home,omitempty"`
	Shell         string            `json:"shell,omitempty"`
	Version       string            `json:"version,omitempty"`
	BootID        string            `json:"boot_id,omitempty"`
	Complete      bool              `json:"complete,omitempty"`
	Capabilities  []string          `json:"capabilities,omitempty"`
	Path          string            `json:"path,omitempty"`
	IncludeHidden bool              `json:"include_hidden,omitempty"`
	Directory     *DirectoryListing `json:"directory,omitempty"`
	Workspace     *files.Workspace  `json:"workspace,omitempty"`
	RootChange    *files.RootChange `json:"root_change,omitempty"`
	Codex         *CodexObservation `json:"codex,omitempty"`
	WorkspaceID   string            `json:"workspace_id,omitempty"`
	RootRevision  int64             `json:"root_revision,omitempty"`
	OperationID   string            `json:"operation_id,omitempty"`
	ErrorCode     string            `json:"error_code,omitempty"`
}

type Frame struct {
	Type       string   `json:"type"`
	Cols       uint16   `json:"cols,omitempty"`
	Rows       uint16   `json:"rows,omitempty"`
	Bytes      int      `json:"bytes,omitempty"`
	ReadOnly   bool     `json:"readonly"`
	Message    string   `json:"message,omitempty"`
	ID         string   `json:"id,omitempty"`
	SDP        string   `json:"sdp,omitempty"`
	Route      string   `json:"route,omitempty"`
	Padding    string   `json:"padding,omitempty"`
	ICEServers []string `json:"ice_servers,omitempty"`
}
