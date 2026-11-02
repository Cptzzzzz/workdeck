package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

type Config struct {
	Addr, PublicURL, DataDir, AssetsDir, AdminUser, PasswordFile, TrustedProxyCIDR string
	TailnetProbeURL, TailnetProbeSecretFile                                        string
	SessionTTL                                                                     time.Duration
}
type attempt struct {
	Since time.Time
	Count int
}
type agentConn struct {
	socket *protocol.Socket
	nodeID string
}
type pending struct {
	nodeID, terminalID string
	ch                 chan *protocol.Socket
	expires            time.Time
}
type attachment struct {
	id, terminalID, nodeID, loginHash string
	browser                           *protocol.Socket
	agent                             *protocol.Socket
	readonly                          bool
	windows                           bool
	cancel                            context.CancelFunc
}
type waiter struct {
	nodeID string
	ch     chan protocol.Message
}
type Hub struct {
	cfg                 Config
	store               *Store
	mu                  sync.Mutex
	authMu              sync.Mutex
	nodeMu              sync.Mutex
	agents              map[string]*agentConn
	requests            map[string]waiter
	pending             map[string]*pending
	attachments         map[string]*attachment
	controllers         map[string]string
	attempts            map[string]attempt
	nonces              map[string]time.Time
	dummyHash           []byte
	workspaceLocks      [64]sync.Mutex
	workspaceRecovering map[string]bool
	fileTickets         map[string]*fileBrowserTicket
	downloadResumes     map[string]*fileBrowserTicket
	filePending         map[string]*fileAgentTicket
	fileConnections     map[string]*fileConnection
	stateSubscribers    map[chan struct{}]struct{}
	tailProbeSecret     []byte
	tailProbeOrigin     string
	tailChallenges      map[string]tailChallenge
	tailBindings        map[string]tailBinding
	tailTraceLast       time.Time
}

func (h *Hub) workspaceLock(terminal string) *sync.Mutex {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(terminal))
	return &h.workspaceLocks[hash.Sum32()%uint32(len(h.workspaceLocks))]
}

func New(cfg Config) (*Hub, error) {
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 30 * 24 * time.Hour
	}
	if cfg.SessionTTL < time.Hour || cfg.SessionTTL > 365*24*time.Hour {
		return nil, errors.New("session lifetime must be between one hour and one year")
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if !strings.HasPrefix(cfg.PublicURL, "https://") && !strings.HasPrefix(cfg.PublicURL, "http://127.0.0.1:") && !strings.HasPrefix(cfg.PublicURL, "http://localhost:") {
		return nil, errors.New("public URL must use HTTPS (HTTP allowed only for localhost development)")
	}
	var probeSecret []byte
	var probeOrigin string
	if cfg.TailnetProbeURL != "" || cfg.TailnetProbeSecretFile != "" {
		if cfg.TailnetProbeURL == "" || cfg.TailnetProbeSecretFile == "" {
			return nil, errors.New("Tailnet probe URL and secret file must be configured together")
		}
		u, err := url.Parse(cfg.TailnetProbeURL)
		if err != nil || u.Scheme != "https" || len(u.Hostname()) > 253 || !regexp.MustCompile(`^[A-Za-z0-9.-]+$`).MatchString(u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/probe" {
			return nil, errors.New("Tailnet probe must be an HTTPS URL ending in /probe")
		}
		if p := u.Port(); p != "" {
			if n, e := strconv.ParseUint(p, 10, 16); e != nil || n == 0 {
				return nil, errors.New("invalid Tailnet probe port")
			}
		}
		probeOrigin = u.Scheme + "://" + u.Host
		probeSecret, err = os.ReadFile(cfg.TailnetProbeSecretFile)
		if err != nil || len(probeSecret) < 32 || len(probeSecret) > 4096 {
			return nil, errors.New("Tailnet probe secret file must contain 32–4096 bytes")
		}
	}
	s, err := OpenStore(cfg.DataDir, cfg.AdminUser, cfg.PasswordFile)
	if err != nil {
		return nil, err
	}
	dummy, _ := hashPassword(randomID())
	return &Hub{cfg: cfg, store: s, agents: map[string]*agentConn{}, requests: map[string]waiter{}, pending: map[string]*pending{}, attachments: map[string]*attachment{}, controllers: map[string]string{}, attempts: map[string]attempt{}, nonces: map[string]time.Time{}, dummyHash: dummy, tailProbeSecret: probeSecret, tailProbeOrigin: probeOrigin, tailChallenges: map[string]tailChallenge{}, tailBindings: map[string]tailBinding{}}, nil
}
func (h *Hub) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := h.store.db.Ping(); err != nil {
			failure(w, 503, "database unavailable")
			return
		}
		respond(w, 200, map[string]string{"status": "ok"})
	})
	m.HandleFunc("POST /api/login", h.signIn)
	m.HandleFunc("POST /api/logout", h.protected(h.signOut))
	m.HandleFunc("GET /api/me", h.protected(func(w http.ResponseWriter, r *http.Request, l login) {
		respond(w, 200, map[string]string{"username": l.Username, "csrf": l.CSRF})
	}))
	m.HandleFunc("POST /api/tailnet/probe", h.protected(h.startTailProbe))
	m.HandleFunc("POST /api/tailnet/probe/complete", h.protected(h.completeTailProbe))
	m.HandleFunc("GET /api/tailnet/diagnostic", h.protected(h.tailnetDiagnosticConfig))
	m.HandleFunc("POST /api/tailnet/diagnostic", h.protected(h.recordTailnetDiagnostic))
	m.HandleFunc("POST /api/account/password", h.protected(h.changePassword))
	m.HandleFunc("GET /api/state", h.protected(h.state))
	m.HandleFunc("GET /api/events", h.protected(h.stateEvents))
	m.HandleFunc("POST /api/enrollments", h.protected(h.newEnrollment))
	m.HandleFunc("POST /api/terminals", h.protected(h.createTerminal))
	m.HandleFunc("PATCH /api/terminals/{id}", h.protected(h.renameTerminal))
	m.HandleFunc("PUT /api/terminals/{id}/task", h.protected(h.updateTask))
	m.HandleFunc("DELETE /api/terminals/{id}", h.protected(h.closeTerminal))
	m.HandleFunc("GET /api/terminals/{id}/workspace", h.protected(h.getWorkspace))
	m.HandleFunc("POST /api/terminals/{id}/workspace", h.protected(h.createWorkspace))
	m.HandleFunc("PUT /api/terminals/{id}/workspace", h.protected(h.changeWorkspace))
	m.HandleFunc("POST /api/workspaces/{id}/connections", h.protected(h.newFileConnection))
	m.HandleFunc("GET /api/workspaces/{id}/ws", h.protected(h.browserFileSocket))
	m.HandleFunc("POST /api/workspaces/{id}/downloads", h.protected(h.newDownloadTicket))
	m.HandleFunc("GET /api/workspaces/{id}/downloads/{ticket}", h.protected(h.downloadFile))
	m.HandleFunc("GET /api/terminals/{id}/ws", h.protected(h.browserSocket))
	m.HandleFunc("DELETE /api/nodes/{id}", h.protected(h.revokeNode))
	m.HandleFunc("PATCH /api/nodes/{id}", h.protected(h.renameNode))
	m.HandleFunc("POST /api/nodes/{id}/codex-hooks", h.protected(h.installNodeCodexHooks))
	m.HandleFunc("DELETE /api/nodes/{id}/codex-hooks", h.protected(h.installNodeCodexHooks))
	m.HandleFunc("GET /api/nodes/{id}/directories", h.protected(h.directories))
	m.HandleFunc("POST /api/agent/enroll", h.enroll)
	m.HandleFunc("GET /api/agent/control", h.controlSocket)
	m.HandleFunc("GET /api/agent/data", h.dataSocket)
	m.HandleFunc("GET /api/agent/files", h.agentFileSocket)
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { failure(w, 404, "接口不存在") })
	m.HandleFunc("/", h.assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		connect := "'self'"
		if h.tailProbeOrigin != "" {
			connect += " " + h.tailProbeOrigin
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src "+connect+"; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("Cache-Control", "no-store")
		defer func() {
			if v := recover(); v != nil {
				log.Printf("http panic: %v", v)
				failure(w, 500, "内部错误")
			}
		}()
		m.ServeHTTP(w, r)
	})
}
func (h *Hub) Run(ctx context.Context) error {
	server := &http.Server{Addr: h.cfg.Addr, Handler: h.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 32768}
	go func() {
		<-ctx.Done()
		h.mu.Lock()
		for _, a := range h.agents {
			a.socket.Close()
		}
		for _, a := range h.attachments {
			a.cancel()
		}
		for _, a := range h.fileConnections {
			a.cancel()
		}
		h.mu.Unlock()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	log.Printf("Hub listening on %s; public URL %s", h.cfg.Addr, h.cfg.PublicURL)
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func (h *Hub) assets(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		failure(w, 405, "不支持此操作")
		return
	}
	path := filepath.Clean("/" + r.URL.Path)
	if strings.HasPrefix(path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	f := filepath.Join(h.cfg.AssetsDir, path)
	info, err := os.Stat(f)
	if errors.Is(err, fs.ErrNotExist) || err == nil && info.IsDir() {
		f = filepath.Join(h.cfg.AssetsDir, "index.html")
	}
	http.ServeFile(w, r, f)
}
func (h *Hub) state(w http.ResponseWriter, r *http.Request, l login) {
	nodes := []Node{}
	rows, err := h.store.db.Query("SELECT id,name,last_seen,hostname,platform,home,shell,version,capabilities,run_user,hardware FROM nodes WHERE revoked=0 ORDER BY name")
	if err != nil {
		failure(w, 500, "读取节点失败")
		return
	}
	for rows.Next() {
		var n Node
		var capabilities, hardware string
		if err = rows.Scan(&n.ID, &n.Name, &n.LastSeen, &n.Hostname, &n.Platform, &n.Home, &n.Shell, &n.Version, &capabilities, &n.RunUser, &hardware); err != nil {
			rows.Close()
			failure(w, 500, "读取节点失败")
			return
		}
		n.Capabilities = []string{}
		_ = json.Unmarshal([]byte(capabilities), &n.Capabilities)
		if hardware != "" {
			var h protocol.NodeHardware
			if json.Unmarshal([]byte(hardware), &h) == nil {
				n.Hardware = cleanHardware(&h)
			}
		}
		h.mu.Lock()
		n.Online = h.agents[n.ID] != nil
		h.mu.Unlock()
		nodes = append(nodes, n)
	}
	rows.Close()
	terms := []Terminal{}
	rows, err = h.store.db.Query("SELECT " + terminalFields + " FROM terminals ORDER BY created_at DESC")
	if err != nil {
		failure(w, 500, "读取终端失败")
		return
	}
	for rows.Next() {
		t, e := scanTerm(rows)
		if e != nil {
			rows.Close()
			failure(w, 500, "读取终端失败")
			return
		}
		h.mu.Lock()
		for _, a := range h.attachments {
			if a.terminalID == t.ID {
				t.Viewers++
			}
		}
		h.mu.Unlock()
		terms = append(terms, t)
	}
	rows.Close()
	rows, err = h.store.db.Query("SELECT terminal_id,note,tags,important,manual_status,codex_turn,codex_completed_at,codex_command,codex_status,codex_event,codex_observed_at,codex_detected FROM terminal_tasks")
	if err != nil {
		failure(w, 500, "读取任务失败")
		return
	}
	tasks := map[string]*TaskInfo{}
	for rows.Next() {
		var id string
		var task TaskInfo
		if err = rows.Scan(&id, &task.Note, &task.Tags, &task.Important, &task.ManualStatus, &task.CodexTurn, &task.CodexCompletedAt, &task.CodexCommand, &task.CodexStatus, &task.CodexEvent, &task.CodexObservedAt, &task.CodexDetected); err != nil {
			rows.Close()
			failure(w, 500, "读取任务失败")
			return
		}
		tasks[id] = &task
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		failure(w, 500, "读取任务失败")
		return
	}
	for i := range terms {
		terms[i].Task = tasks[terms[i].ID]
	}
	respond(w, 200, map[string]any{"nodes": nodes, "terminals": terms})
}

func (h *Hub) stateEvents(w http.ResponseWriter, r *http.Request, l login) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		failure(w, 500, "不支持事件流")
		return
	}
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.stateSubscribers == nil {
		h.stateSubscribers = map[chan struct{}]struct{}{}
	}
	h.stateSubscribers[ch] = struct{}{}
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.stateSubscribers, ch); h.mu.Unlock() }()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			_, _ = io.WriteString(w, "event: state\ndata: changed\n\n")
			flusher.Flush()
		case <-t.C:
			if _, ok := h.loginFor(r); !ok {
				return
			}
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (h *Hub) publishState() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.stateSubscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (h *Hub) installNodeCodexHooks(w http.ResponseWriter, r *http.Request, l login) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	command := "codex.install"
	if r.Method == "DELETE" {
		command = "codex.remove"
	}
	result, err := h.command(ctx, r.PathValue("id"), protocol.Message{Type: command})
	if err != nil {
		failure(w, 503, "节点离线或不支持安装，请先升级节点")
		return
	}
	if result.Error != "" {
		failure(w, 400, result.Error)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

type codexDB interface {
	Exec(string, ...any) (sql.Result, error)
}

func saveCodexObservation(db codexDB, node, id string, c *protocol.CodexObservation) error {
	if c == nil || validateID(id) != nil || len(c.TurnID) > 128 || len(c.CompletedAt) > 64 || len(c.LaunchCommand) > 4096 || len(c.EventID) > 128 || len(c.ObservedAt) > 64 {
		return errors.New("invalid Codex observation")
	}
	switch c.Status {
	case "", "ready", "running", "attention", "turn_ended", "interrupted", "session_ended", "unknown":
	default:
		return errors.New("invalid Codex status")
	}
	if c.Status != "" {
		if c.EventID == "" {
			return errors.New("missing event ID")
		}
		if _, err := time.Parse(time.RFC3339Nano, c.ObservedAt); err != nil {
			return errors.New("invalid event time")
		}
	}
	_, err := db.Exec(`INSERT INTO terminal_tasks(terminal_id,codex_turn,codex_completed_at,codex_command,codex_status,codex_event,codex_observed_at,codex_detected)
	 SELECT id,?,?,?,?,?,?,? FROM terminals WHERE id=? AND node_id=?
	 ON CONFLICT(terminal_id) DO UPDATE SET
	 codex_turn=CASE WHEN excluded.codex_turn<>'' AND ((excluded.codex_observed_at='' AND terminal_tasks.codex_observed_at='') OR (excluded.codex_observed_at<>'' AND excluded.codex_observed_at>=terminal_tasks.codex_observed_at)) THEN excluded.codex_turn ELSE terminal_tasks.codex_turn END,
	 codex_completed_at=CASE WHEN excluded.codex_turn<>'' AND ((excluded.codex_observed_at='' AND terminal_tasks.codex_observed_at='') OR (excluded.codex_observed_at<>'' AND excluded.codex_observed_at>=terminal_tasks.codex_observed_at)) THEN excluded.codex_completed_at ELSE terminal_tasks.codex_completed_at END,
	 codex_command=CASE WHEN excluded.codex_command<>'' THEN excluded.codex_command ELSE terminal_tasks.codex_command END,
	 codex_status=CASE WHEN excluded.codex_observed_at<>'' AND excluded.codex_observed_at>=terminal_tasks.codex_observed_at THEN excluded.codex_status ELSE terminal_tasks.codex_status END,
	 codex_event=CASE WHEN excluded.codex_observed_at<>'' AND excluded.codex_observed_at>=terminal_tasks.codex_observed_at THEN excluded.codex_event ELSE terminal_tasks.codex_event END,
	 codex_observed_at=CASE WHEN excluded.codex_observed_at<>'' AND excluded.codex_observed_at>=terminal_tasks.codex_observed_at THEN excluded.codex_observed_at ELSE terminal_tasks.codex_observed_at END,
	 codex_detected=COALESCE(excluded.codex_detected,terminal_tasks.codex_detected)`, c.TurnID, c.CompletedAt, c.LaunchCommand, c.Status, c.EventID, c.ObservedAt, c.Detected, id, node)
	return err
}

func (h *Hub) updateTask(w http.ResponseWriter, r *http.Request, l login) {
	var in struct {
		Note         string `json:"note"`
		Tags         string `json:"tags"`
		Important    bool   `json:"important"`
		ManualStatus string `json:"manual_status"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Note = strings.TrimSpace(in.Note)
	in.Tags = strings.TrimSpace(in.Tags)
	if len(in.Note) > 2000 || len(in.Tags) > 300 {
		failure(w, 400, "备注或标签过长")
		return
	}
	switch in.ManualStatus {
	case "", "doing", "waiting", "done":
	default:
		failure(w, 400, "任务状态无效")
		return
	}
	if _, err := h.store.terminal(r.PathValue("id")); errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "终端不存在")
		return
	} else if err != nil {
		failure(w, 500, "读取失败")
		return
	}
	_, err := h.store.db.Exec("INSERT INTO terminal_tasks(terminal_id,note,tags,important,manual_status) VALUES(?,?,?,?,?) ON CONFLICT(terminal_id) DO UPDATE SET note=excluded.note,tags=excluded.tags,important=excluded.important,manual_status=excluded.manual_status", r.PathValue("id"), in.Note, in.Tags, in.Important, in.ManualStatus)
	if err != nil {
		failure(w, 500, "保存任务失败")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Hub) newEnrollment(w http.ResponseWriter, r *http.Request, l login) {
	token := randomID()
	expiry := time.Now().Add(10 * time.Minute)
	_, err := h.store.db.Exec("INSERT INTO enrollments VALUES(?,?)", digest(token), expiry.Unix())
	if err != nil {
		failure(w, 500, "创建令牌失败")
		return
	}
	_, _ = h.store.db.Exec("DELETE FROM enrollments WHERE expires<?", time.Now().Unix())
	_, _ = h.store.db.Exec("DELETE FROM enrollment_claims WHERE expires<?", time.Now().Unix())
	respond(w, 201, map[string]string{"token": token, "expires_at": expiry.UTC().Format(time.RFC3339), "hub": h.cfg.PublicURL})
}
func (h *Hub) nodeOnline(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agents[id] != nil
}
func (h *Hub) createTerminal(w http.ResponseWriter, r *http.Request, l login) {
	var in struct {
		NodeID string `json:"node_id"`
		Name   string `json:"name"`
		Cwd    string `json:"cwd"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 100 || len(in.Cwd) > 4096 {
		failure(w, 400, "终端名称或目录无效")
		return
	}
	if !h.nodeOnline(in.NodeID) {
		failure(w, 409, "节点当前离线")
		return
	}
	var home string
	if h.store.db.QueryRow("SELECT home FROM nodes WHERE id=? AND revoked=0", in.NodeID).Scan(&home) != nil {
		failure(w, 404, "节点不存在")
		return
	}
	if in.Cwd == "" {
		in.Cwd = home
	}
	if !filepath.IsAbs(in.Cwd) || strings.ContainsRune(in.Cwd, 0) {
		failure(w, 400, "工作目录必须是绝对路径")
		return
	}
	id := randomID()
	ts := now()
	_, err := h.store.db.Exec("INSERT INTO terminals("+terminalFields+") VALUES(?,?,?,?,?,?,?,?,?,NULL)", id, in.NodeID, in.Name, in.Cwd, "running", "creating", ts, ts, "")
	if err != nil {
		failure(w, 500, "保存终端失败")
		return
	}
	result, e := h.command(r.Context(), in.NodeID, protocol.Message{Type: "create", TerminalID: id, Session: &protocol.Session{ID: id, Name: in.Name, Cwd: in.Cwd, CreatedAt: ts}})
	if e == nil {
		h.applyResult(id, result)
	}
	t, _ := h.store.terminal(id)
	respond(w, 201, t)
}
func (h *Hub) renameTerminal(w http.ResponseWriter, r *http.Request, l login) {
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 100 {
		failure(w, 400, "名称需要 1–100 字节")
		return
	}
	result, err := h.store.db.Exec("UPDATE terminals SET name=?,updated_at=? WHERE id=?", in.Name, now(), r.PathValue("id"))
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		failure(w, 404, "终端不存在")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Hub) closeTerminal(w http.ResponseWriter, r *http.Request, l login) {
	id := r.PathValue("id")
	t, err := h.store.terminal(id)
	if errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "终端不存在")
		return
	}
	if err != nil {
		failure(w, 500, "读取失败")
		return
	}
	_, err = h.store.db.Exec("UPDATE terminals SET desired_state='closed',updated_at=? WHERE id=?", now(), id)
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	h.closeTerminalAttachments(id)
	if h.nodeOnline(t.NodeID) {
		result, e := h.command(r.Context(), t.NodeID, protocol.Message{Type: "close", TerminalID: id})
		if e == nil {
			h.applyResult(id, result)
		}
	}
	t, _ = h.store.terminal(id)
	respond(w, 200, t)
}
func (h *Hub) renameNode(w http.ResponseWriter, r *http.Request, l login) {
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 100 {
		failure(w, 400, "节点名称需要 1–100 字节")
		return
	}
	result, err := h.store.db.Exec("UPDATE nodes SET name=? WHERE id=? AND revoked=0", in.Name, r.PathValue("id"))
	if err != nil {
		failure(w, 500, "保存节点名称失败")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		failure(w, 404, "节点不存在")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Hub) revokeNode(w http.ResponseWriter, r *http.Request, l login) {
	id := r.PathValue("id")
	h.nodeMu.Lock()
	defer h.nodeMu.Unlock()
	_, err := h.store.db.Exec("UPDATE nodes SET revoked=1 WHERE id=?", id)
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	h.mu.Lock()
	h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.nodeID == id })
	h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return t.nodeID == id })
	if a := h.agents[id]; a != nil {
		a.socket.Close()
		delete(h.agents, id)
	}
	for _, a := range h.attachments {
		if a.nodeID == id {
			a.cancel()
		}
	}
	h.mu.Unlock()
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Hub) command(ctx context.Context, node string, msg protocol.Message) (protocol.Message, error) {
	msg.RequestID = randomID()
	ch := make(chan protocol.Message, 1)
	h.mu.Lock()
	a := h.agents[node]
	if a == nil {
		h.mu.Unlock()
		return protocol.Message{}, errors.New("node offline")
	}
	h.requests[msg.RequestID] = waiter{node, ch}
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.requests, msg.RequestID); h.mu.Unlock() }()
	if err := a.socket.JSON(msg); err != nil {
		return protocol.Message{}, err
	}
	select {
	case result := <-ch:
		return result, nil
	case <-time.After(12 * time.Second):
		return protocol.Message{}, errors.New("node response timeout")
	case <-ctx.Done():
		return protocol.Message{}, ctx.Err()
	}
}
func (h *Hub) applyResult(id string, msg protocol.Message) {
	if msg.Session != nil {
		_, _ = h.store.db.Exec("UPDATE terminals SET observed_state=?,error=?,exit_code=?,updated_at=? WHERE id=?", msg.Session.State, msg.Session.Error, msg.Session.ExitCode, now(), id)
	} else if msg.Error != "" {
		_, _ = h.store.db.Exec("UPDATE terminals SET observed_state='error',error=?,updated_at=? WHERE id=?", msg.Error, now(), id)
	}
}
func (h *Hub) applyInventory(node string, msg protocol.Message) {
	tx, err := h.store.db.Begin()
	if err != nil {
		log.Printf("inventory database: %v", err)
		return
	}
	defer tx.Rollback()
	var previousBoot string
	if err = tx.QueryRow("SELECT boot_id FROM nodes WHERE id=?", node).Scan(&previousBoot); err != nil {
		return
	}
	capabilities, _ := json.Marshal(msg.Capabilities)
	if msg.Capabilities == nil {
		capabilities = []byte("[]")
	}
	_, err = tx.Exec("UPDATE nodes SET last_seen=?,hostname=?,platform=?,home=?,shell=?,version=?,boot_id=?,capabilities=?,run_user=CASE WHEN ?<>'' THEN ? ELSE run_user END WHERE id=?", now(), msg.Hostname, msg.Platform, msg.Home, msg.Shell, msg.Version, msg.BootID, string(capabilities), msg.RunUser, msg.RunUser, node)
	if err != nil {
		log.Printf("inventory update: %v", err)
		return
	}
	if hardware := encodeHardware(msg.Hardware); hardware != "" {
		if _, err = tx.Exec("UPDATE nodes SET hardware=? WHERE id=?", hardware, node); err != nil {
			log.Printf("inventory hardware update: %v", err)
			return
		}
	}
	seen := map[string]bool{}
	complete := msg.Complete
	detach := []string{}
	for _, session := range msg.Sessions {
		if validateID(session.ID) != nil {
			complete = false
			continue
		}
		switch session.State {
		case "creating", "running", "exited", "closed", "lost", "error":
		default:
			complete = false
			continue
		}
		seen[session.ID] = true
		result, err := tx.Exec("UPDATE terminals SET observed_state=?,error=?,exit_code=?,updated_at=? WHERE id=? AND node_id=?", session.State, session.Error, session.ExitCode, now(), session.ID, node)
		if err != nil {
			log.Printf("inventory session update: %v", err)
			return
		}
		matched, _ := result.RowsAffected()
		if matched > 0 && session.Codex != nil {
			err = saveCodexObservation(tx, node, session.ID, session.Codex)
			if err != nil {
				log.Printf("task inventory update: %v", err)
				return
			}
		}
		if session.State == "lost" || session.State == "closed" || session.State == "error" {
			detach = append(detach, session.ID)
		}
	}
	rows, err := tx.Query("SELECT "+terminalFields+" FROM terminals WHERE node_id=?", node)
	if err != nil {
		return
	}
	list := []Terminal{}
	for rows.Next() {
		t, e := scanTerm(rows)
		if e != nil {
			rows.Close()
			return
		}
		list = append(list, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return
	}
	commands := []protocol.Message{}
	for _, t := range list {
		if complete && !seen[t.ID] && (t.State == "running" || t.State == "exited") {
			reason := "节点已同步完整清单，但未发现此会话；记录已保留，可重新创建"
			if previousBoot != "" && msg.BootID != "" && previousBoot != msg.BootID {
				reason = "节点已重启，原终端进程已结束；记录已保留，可重新创建"
			}
			if _, err = tx.Exec("UPDATE terminals SET observed_state='lost',error=?,updated_at=? WHERE id=?", reason, now(), t.ID); err != nil {
				return
			}
			detach = append(detach, t.ID)
		}
		command := protocol.Message{TerminalID: t.ID}
		if t.Desired == "closed" && t.State != "closed" {
			command.Type = "close"
		} else if t.State == "creating" && !seen[t.ID] && complete {
			command.Type = "create"
			command.Session = &protocol.Session{ID: t.ID, Name: t.Name, Cwd: t.Cwd, CreatedAt: t.CreatedAt}
		} else {
			continue
		}
		commands = append(commands, command)
	}
	if err = tx.Commit(); err != nil {
		log.Printf("inventory commit: %v", err)
		return
	}
	for _, capability := range msg.Capabilities {
		if capability == "workspace-control-v1" {
			h.scheduleWorkspaceRecovery(node)
			break
		}
	}
	for _, id := range detach {
		h.closeTerminalAttachments(id)
	}
	for _, command := range commands {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if result, e := h.command(ctx, node, command); e == nil {
				h.applyResult(command.TerminalID, result)
			}
		}()
	}
}
func (h *Hub) controlSocket(w http.ResponseWriter, r *http.Request) {
	node, ok := h.agentIdentity(r)
	if !ok {
		failure(w, 401, "节点认证失败")
		return
	}
	conn, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s := &protocol.Socket{Conn: conn}
	s.SetReadLiveness(2 << 20)
	defer s.Close()
	done := make(chan struct{})
	defer close(done)
	go s.Heartbeat(done)
	a := &agentConn{s, node}
	// Recheck revocation after the upgrade under the same lock used by node
	// removal. A handshake authenticated just before revocation cannot
	// reinstall the node's control connection afterwards.
	h.nodeMu.Lock()
	var revoked int
	if h.store.db.QueryRow("SELECT revoked FROM nodes WHERE id=?", node).Scan(&revoked) != nil || revoked != 0 {
		h.nodeMu.Unlock()
		return
	}
	h.mu.Lock()
	old := h.agents[node]
	h.agents[node] = a
	if old != nil {
		h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.agent == old })
		old.socket.Close()
	}
	h.mu.Unlock()
	h.nodeMu.Unlock()
	log.Printf("node connected: %s", node)
	defer func() {
		h.mu.Lock()
		if h.agents[node] == a {
			delete(h.agents, node)
			h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.agent == a })
			for _, at := range h.attachments {
				if at.nodeID == node {
					at.cancel()
				}
			}
		}
		h.mu.Unlock()
		log.Printf("node disconnected: %s", node)
	}()
	for {
		var msg protocol.Message
		if err = conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "inventory":
			h.applyInventory(node, msg)
		case "codex.update":
			if err := saveCodexObservation(h.store.db, node, msg.TerminalID, msg.Codex); err == nil {
				h.publishState()
			}
		case "result":
			h.mu.Lock()
			wait, exists := h.requests[msg.RequestID]
			h.mu.Unlock()
			if exists && wait.nodeID == node {
				select {
				case wait.ch <- msg:
				default:
				}
			}
		}
	}
}
func (h *Hub) closeLogin(hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeTailBindingsLocked(func(loginHash string) bool { return loginHash != hash })
	h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.loginHash == hash })
	h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return t.loginHash == hash })
	for _, a := range h.attachments {
		if a.loginHash == hash {
			a.cancel()
		}
	}
}
func (h *Hub) closeOtherLogins(hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeTailBindingsLocked(func(loginHash string) bool { return loginHash == hash })
	h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.loginHash != hash })
	h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return t.loginHash != hash })
	for _, a := range h.attachments {
		if a.loginHash != hash {
			a.cancel()
		}
	}
}
func (h *Hub) closeTerminalAttachments(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, a := range h.attachments {
		if a.terminalID == id {
			a.cancel()
		}
	}
}
func (h *Hub) dataSocket(w http.ResponseWriter, r *http.Request) {
	node, ok := h.agentIdentity(r)
	if !ok {
		failure(w, 401, "节点认证失败")
		return
	}
	ticket := r.Header.Get("X-Workdeck-Ticket")
	h.mu.Lock()
	p := h.pending[ticket]
	if p == nil || p.nodeID != node || time.Now().After(p.expires) {
		h.mu.Unlock()
		failure(w, 403, "连接凭证失效")
		return
	}
	delete(h.pending, ticket)
	h.mu.Unlock()
	conn, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s := &protocol.Socket{Conn: conn}
	s.SetReadLiveness(1 << 20)
	select {
	case p.ch <- s:
	case <-time.After(time.Second):
		s.Close()
	}
}
func clampSize(n uint16, min, max uint16) uint16 {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// Capture only when Windows attachments to this node belong to one login.
// Multiple terminal tabs from that login are fine; ambiguous devices are not.
func (h *Hub) allowWindowsRTCTrace(a *attachment) bool {
	if !a.windows {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, other := range h.attachments {
		if other.nodeID == a.nodeID && other.windows && other.loginHash != a.loginHash {
			return false
		}
	}
	return true
}
func (h *Hub) browserSocket(w http.ResponseWriter, r *http.Request, l login) {
	t, err := h.store.terminal(r.PathValue("id"))
	if err != nil {
		failure(w, 404, "终端不存在")
		return
	}
	if t.Desired == "closed" || t.State == "closed" || t.State == "lost" || t.State == "error" {
		failure(w, 409, "终端已结束或不可用")
		return
	}
	h.mu.Lock()
	agent := h.agents[t.NodeID]
	h.mu.Unlock()
	if agent == nil {
		failure(w, 409, "节点离线")
		return
	}
	conn, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == h.cfg.PublicURL }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	browser := &protocol.Socket{Conn: conn}
	browser.SetReadLiveness(65536)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer browser.Close()
	a := &attachment{id: randomID(), terminalID: t.ID, nodeID: t.NodeID, loginHash: l.Hash, browser: browser, cancel: cancel, windows: strings.Contains(r.UserAgent(), "Windows")}
	ticket := randomID()
	p := &pending{nodeID: t.NodeID, terminalID: t.ID, ch: make(chan *protocol.Socket), expires: time.Now().Add(15 * time.Second)}
	h.mu.Lock()
	controller := h.controllers[t.ID]
	if controller == "" || r.URL.Query().Get("takeover") == "1" {
		h.controllers[t.ID] = a.id
		if old := h.attachments[controller]; old != nil {
			old.cancel()
		}
	} else {
		a.readonly = true
	}
	h.attachments[a.id] = a
	h.pending[ticket] = p
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.attachments, a.id)
		delete(h.pending, ticket)
		if h.controllers[t.ID] == a.id {
			delete(h.controllers, t.ID)
		}
		h.mu.Unlock()
	}()
	// Closing a view never closes its tmux session.
	go func() { <-ctx.Done(); browser.Close() }()
	if err = agent.socket.JSON(protocol.Message{Type: "attach", TerminalID: t.ID, Ticket: ticket, ReadOnly: a.readonly, Cols: 100, Rows: 30}); err != nil {
		return
	}
	var data *protocol.Socket
	select {
	case data = <-p.ch:
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
		_ = browser.JSON(protocol.Frame{Type: "error", Message: "连接节点超时，请重试"})
		return
	}
	defer data.Close()
	go func() { <-ctx.Done(); data.Close() }()
	done := make(chan struct{})
	defer close(done)
	go browser.Heartbeat(done)
	go data.Heartbeat(done)
	if err = browser.JSON(protocol.Frame{Type: "ready", ReadOnly: a.readonly}); err != nil {
		return
	}
	errorsCh := make(chan error, 2)
	var nodeTraceAvailable atomic.Bool
	go func() {
		for {
			kind, b, e := data.Conn.ReadMessage()
			if e != nil {
				errorsCh <- e
				return
			}
			if kind != websocket.BinaryMessage && kind != websocket.TextMessage {
				continue
			}
			if kind == websocket.TextMessage {
				var f protocol.Frame
				if json.Unmarshal(b, &f) == nil && f.Type == "rtc-config" {
					nodeTraceAvailable.Store(f.RTCTraceAvailable)
				}
			}
			if e = browser.Write(kind, b); e != nil {
				errorsCh <- e
				return
			}
		}
	}()
	go func() {
		for {
			kind, b, e := browser.Conn.ReadMessage()
			if e != nil {
				errorsCh <- e
				return
			}
			if kind == websocket.BinaryMessage {
				h.mu.Lock()
				controlling := h.controllers[t.ID] == a.id
				h.mu.Unlock()
				if a.readonly || !controlling {
					continue
				}
				if len(b) > 32768 {
					errorsCh <- fmt.Errorf("input too large")
					return
				}
				e = data.Write(kind, b)
			} else if kind == websocket.TextMessage {
				var f protocol.Frame
				if json.Unmarshal(b, &f) != nil {
					continue
				}
				switch f.Type {
				case "scroll-exit":
					h.mu.Lock()
					controlling := h.controllers[t.ID] == a.id
					h.mu.Unlock()
					if !a.readonly && controlling {
						e = data.JSON(f)
					}
				case "probe", "rtc-offer", "rtc-candidate", "rtc-trace", "route-request", "route-commit":
					if f.Type == "rtc-offer" {
						f.RTCTraceRequested = nodeTraceAvailable.Load() && h.allowWindowsRTCTrace(a)
					}
					// Signaling shares this authenticated attachment. Its lifetime
					// remains the authority for any direct data channel as well.
					if len(f.ID) <= 64 && len(f.SDP) <= 60000 && len(f.Padding) <= 1024 && (f.Candidate == nil || (len(f.Candidate.Candidate) <= 2048 && (f.Candidate.SDPMid == nil || len(*f.Candidate.SDPMid) <= 256) && (f.Candidate.UsernameFragment == nil || len(*f.Candidate.UsernameFragment) <= 256))) {
						e = data.JSON(f)
					}
				case "resize":
					h.mu.Lock()
					controlling := h.controllers[t.ID] == a.id
					h.mu.Unlock()
					if !a.readonly && !controlling {
						continue
					}
					f.Cols = clampSize(f.Cols, 10, 500)
					f.Rows = clampSize(f.Rows, 3, 250)
					e = data.JSON(f)
				case "ack":
					if f.Bytes > 0 && f.Bytes <= 32768 {
						e = data.JSON(f)
					}
				}
			}
			if e != nil {
				errorsCh <- e
				return
			}
		}
	}()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-errorsCh:
			return
		case <-ticker.C:
			var expiry int64
			if h.store.db.QueryRow("SELECT expires FROM logins WHERE hash=?", l.Hash).Scan(&expiry) != nil || expiry <= time.Now().Unix() {
				return
			}
		}
	}
}
