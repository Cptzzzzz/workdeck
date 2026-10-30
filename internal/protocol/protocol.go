package protocol

// Session is metadata only. The live process and terminal screen remain on the node.
type Session struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
	ExitCode  *int   `json:"exit_code,omitempty"`
	CreatedAt string `json:"created_at"`
	BootID    string `json:"boot_id,omitempty"`
	RunUser   string `json:"run_user,omitempty"`
	Scope     string `json:"scope,omitempty"`
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
