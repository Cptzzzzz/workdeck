package protocol

import "workdeck/internal/files"

// Session is metadata only. The live process and terminal screen remain on the node.
type Session struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Cwd       string              `json:"cwd"`
	State     string              `json:"state"`
	Error     string              `json:"error,omitempty"`
	ExitCode  *int                `json:"exit_code,omitempty"`
	CreatedAt string              `json:"created_at"`
	BootID    string              `json:"boot_id,omitempty"`
	RunUser   string              `json:"run_user,omitempty"`
	Scope     string              `json:"scope,omitempty"`
	Codex     *CodexObservation   `json:"codex,omitempty"`
	Launch    *CodexLaunchOptions `json:"launch,omitempty"`
	PanePID   int                 `json:"-"`
}

// CodexObservation contains no prompts or model output. A completion records
// one turn, not whether the user's overall objective was achieved.
type CodexObservation struct {
	TurnID        string     `json:"turn_id,omitempty"`
	CompletedAt   string     `json:"completed_at,omitempty"`
	LaunchCommand string     `json:"launch_command,omitempty"`
	Status        string     `json:"status,omitempty"`
	EventID       string     `json:"event_id,omitempty"`
	ObservedAt    string     `json:"observed_at,omitempty"`
	Detected      *bool      `json:"detected,omitempty"`
	Managed       bool       `json:"managed,omitempty"`
	ThreadID      string     `json:"thread_id,omitempty"`
	Goal          *CodexGoal `json:"goal,omitempty"`
	ProcessKey    string     `json:"process_key,omitempty"`
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

// NodeHardware contains non-unique hardware descriptions only. Serial numbers,
// hardware UUIDs, MAC addresses and filesystem paths must not be included.
type NodeHardware struct {
	CollectedAt   string           `json:"collected_at"`
	CPUModel      string           `json:"cpu_model,omitempty"`
	LogicalCPUs   int              `json:"logical_cpus,omitempty"`
	PhysicalCores int              `json:"physical_cores,omitempty"`
	MemoryBytes   uint64           `json:"memory_bytes,omitempty"`
	MemoryModules []HardwareMemory `json:"memory_modules,omitempty"`
	Disks         []HardwareDisk   `json:"disks,omitempty"`
	GPUs          []HardwareGPU    `json:"gpus,omitempty"`
}
type HardwareMemory struct {
	Vendor    string `json:"vendor,omitempty"`
	Model     string `json:"model,omitempty"`
	SizeBytes uint64 `json:"size_bytes,omitempty"`
}
type HardwareDisk struct {
	Name      string `json:"name"`
	Model     string `json:"model,omitempty"`
	Vendor    string `json:"vendor,omitempty"`
	SizeBytes uint64 `json:"size_bytes,omitempty"`
}
type HardwareGPU struct {
	Model       string `json:"model"`
	MemoryBytes uint64 `json:"memory_bytes,omitempty"`
}

type Message struct {
	RunUser         string            `json:"run_user,omitempty"`
	Type            string            `json:"type"`
	RequestID       string            `json:"request_id,omitempty"`
	TerminalID      string            `json:"terminal_id,omitempty"`
	Session         *Session          `json:"session,omitempty"`
	Sessions        []Session         `json:"sessions,omitempty"`
	Error           string            `json:"error,omitempty"`
	Ticket          string            `json:"ticket,omitempty"`
	ReadOnly        bool              `json:"readonly,omitempty"`
	Cols            uint16            `json:"cols,omitempty"`
	Rows            uint16            `json:"rows,omitempty"`
	Hostname        string            `json:"hostname,omitempty"`
	Platform        string            `json:"platform,omitempty"`
	Home            string            `json:"home,omitempty"`
	Shell           string            `json:"shell,omitempty"`
	Version         string            `json:"version,omitempty"`
	BootID          string            `json:"boot_id,omitempty"`
	Complete        bool              `json:"complete,omitempty"`
	Hardware        *NodeHardware     `json:"hardware,omitempty"`
	Capabilities    []string          `json:"capabilities,omitempty"`
	Path            string            `json:"path,omitempty"`
	IncludeHidden   bool              `json:"include_hidden,omitempty"`
	Directory       *DirectoryListing `json:"directory,omitempty"`
	Workspace       *files.Workspace  `json:"workspace,omitempty"`
	RootChange      *files.RootChange `json:"root_change,omitempty"`
	Codex           *CodexObservation `json:"codex,omitempty"`
	WorkspaceID     string            `json:"workspace_id,omitempty"`
	RootRevision    int64             `json:"root_revision,omitempty"`
	OperationID     string            `json:"operation_id,omitempty"`
	ErrorCode       string            `json:"error_code,omitempty"`
	Prepared        bool              `json:"prepared,omitempty"`
	WarmConnections int               `json:"warm_connections,omitempty"`
	TailnetHost     string            `json:"tailnet_host,omitempty"`
}

type ICECandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// RTCNodePair contains only candidate categories and counters, never addresses or IDs.
type RTCNodePair struct {
	Local             string `json:"local"`
	Remote            string `json:"remote"`
	State             string `json:"state"`
	Count             int    `json:"count"`
	RequestsSent      uint64 `json:"requestsSent"`
	RequestsReceived  uint64 `json:"requestsReceived"`
	ResponsesSent     uint64 `json:"responsesSent"`
	ResponsesReceived uint64 `json:"responsesReceived"`
}
type RTCWireSummary struct {
	Sent            uint64 `json:"requestsSent"`
	Received        uint64 `json:"requestsReceived"`
	SuccessSent     uint64 `json:"successResponsesSent"`
	SuccessReceived uint64 `json:"successResponsesReceived"`
	ErrorSent       uint64 `json:"errorResponsesSent"`
	ErrorReceived   uint64 `json:"errorResponsesReceived"`
	WriteErrors     uint64 `json:"writeErrors"`
}

// RTCBrowserTrace intentionally has no free-form strings, addresses, or IDs.
type RTCBrowserTrace struct {
	ElapsedMs         uint32 `json:"elapsedMs"`
	Stage             uint8  `json:"stage"`
	Outcome           uint8  `json:"outcome"`
	ICE               uint8  `json:"ice"`
	Connection        uint8  `json:"connection"`
	LocalHost         uint16 `json:"localHost"`
	LocalSrflx        uint16 `json:"localSrflx"`
	RemoteHost        uint16 `json:"remoteHost"`
	RemoteSrflx       uint16 `json:"remoteSrflx"`
	PairCount         uint16 `json:"pairCount"`
	RequestsSent      uint32 `json:"requestsSent"`
	ResponsesReceived uint32 `json:"responsesReceived"`
	RequestsReceived  uint32 `json:"requestsReceived"`
	ResponsesSent     uint32 `json:"responsesSent"`
	CountersMask      uint8  `json:"countersMask"`
}
type RTCNodeDiagnostic struct {
	Wire             *RTCWireSummary `json:"wire,omitempty"`
	SampleMs         int64           `json:"sampleMs"`
	Gathering        string          `json:"gathering"`
	ICE              string          `json:"ice"`
	Connection       string          `json:"connection"`
	STUNServers      int             `json:"stunServers"`
	LocalCandidates  map[string]int  `json:"localCandidates"`
	RemoteCandidates map[string]int  `json:"remoteCandidates"`
	RemoteReceived   int             `json:"remoteReceived"`
	RemoteApplied    int             `json:"remoteApplied"`
	RemoteRejected   int             `json:"remoteRejected"`
	RemotePending    int             `json:"remotePending"`
	Pairs            []RTCNodePair   `json:"pairs"`
}

type Frame struct {
	Type              string             `json:"type"`
	Cols              uint16             `json:"cols,omitempty"`
	Rows              uint16             `json:"rows,omitempty"`
	Bytes             int                `json:"bytes,omitempty"`
	ReadOnly          bool               `json:"readonly"`
	Message           string             `json:"message,omitempty"`
	ID                string             `json:"id,omitempty"`
	SDP               string             `json:"sdp,omitempty"`
	Route             string             `json:"route,omitempty"`
	Padding           string             `json:"padding,omitempty"`
	ICEServers        []string           `json:"ice_servers,omitempty"`
	RTCTraceAvailable bool               `json:"rtc_trace_available,omitempty"`
	RTCTraceRequested bool               `json:"rtc_trace_requested,omitempty"`
	BrowserTrace      *RTCBrowserTrace   `json:"browser_trace,omitempty"`
	RTCDiagnostics    bool               `json:"rtc_diagnostics,omitempty"`
	NodeDiagnostic    *RTCNodeDiagnostic `json:"node_diagnostic,omitempty"`
	RTCTrickle        bool               `json:"rtc_trickle,omitempty"`
	RTCPaths          bool               `json:"rtc_paths,omitempty"`
	Candidate         *ICECandidate      `json:"candidate,omitempty"`
}
