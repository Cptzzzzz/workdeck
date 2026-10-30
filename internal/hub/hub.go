package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

type Config struct {
	Addr, PublicURL, DataDir, AssetsDir, AdminUser, PasswordFile, TrustedProxyCIDR string
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
	cancel                            context.CancelFunc
}
type waiter struct {
	nodeID string
	ch     chan protocol.Message
}
type Hub struct {
	cfg         Config
	store       *Store
	mu          sync.Mutex
	agents      map[string]*agentConn
	requests    map[string]waiter
	pending     map[string]*pending
	attachments map[string]*attachment
	controllers map[string]string
	attempts    map[string]attempt
	nonces      map[string]time.Time
	dummyHash   []byte
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
	s, err := OpenStore(cfg.DataDir, cfg.AdminUser, cfg.PasswordFile)
	if err != nil {
		return nil, err
	}
	dummy, _ := hashPassword(randomID())
	return &Hub{cfg: cfg, store: s, agents: map[string]*agentConn{}, requests: map[string]waiter{}, pending: map[string]*pending{}, attachments: map[string]*attachment{}, controllers: map[string]string{}, attempts: map[string]attempt{}, nonces: map[string]time.Time{}, dummyHash: dummy}, nil
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
	m.HandleFunc("POST /api/account/password", h.protected(h.changePassword))
	m.HandleFunc("GET /api/state", h.protected(h.state))
	m.HandleFunc("POST /api/enrollments", h.protected(h.newEnrollment))
	m.HandleFunc("POST /api/terminals", h.protected(h.createTerminal))
	m.HandleFunc("PATCH /api/terminals/{id}", h.protected(h.renameTerminal))
	m.HandleFunc("DELETE /api/terminals/{id}", h.protected(h.closeTerminal))
	m.HandleFunc("GET /api/terminals/{id}/ws", h.protected(h.browserSocket))
	m.HandleFunc("DELETE /api/nodes/{id}", h.protected(h.revokeNode))
	m.HandleFunc("PATCH /api/nodes/{id}", h.protected(h.renameNode))
	m.HandleFunc("GET /api/nodes/{id}/directories", h.protected(h.directories))
	m.HandleFunc("POST /api/agent/enroll", h.enroll)
	m.HandleFunc("GET /api/agent/control", h.controlSocket)
	m.HandleFunc("GET /api/agent/data", h.dataSocket)
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { failure(w, 404, "接口不存在") })
	m.HandleFunc("/", h.assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
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
	rows, err := h.store.db.Query("SELECT id,name,last_seen,hostname,platform,home,shell,version,capabilities,run_user FROM nodes WHERE revoked=0 ORDER BY name")
	if err != nil {
		failure(w, 500, "读取节点失败")
		return
	}
	for rows.Next() {
		var n Node
		var capabilities string
		if err = rows.Scan(&n.ID, &n.Name, &n.LastSeen, &n.Hostname, &n.Platform, &n.Home, &n.Shell, &n.Version, &capabilities, &n.RunUser); err != nil {
			rows.Close()
			failure(w, 500, "读取节点失败")
			return
		}
		n.Capabilities = []string{}
		_ = json.Unmarshal([]byte(capabilities), &n.Capabilities)
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
	respond(w, 200, map[string]any{"nodes": nodes, "terminals": terms})
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
	_, err := h.store.db.Exec("UPDATE nodes SET revoked=1 WHERE id=?", id)
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	h.mu.Lock()
	if a := h.agents[id]; a != nil {
		a.socket.Close()
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
		_, err = tx.Exec("UPDATE terminals SET observed_state=?,error=?,exit_code=?,updated_at=? WHERE id=? AND node_id=?", session.State, session.Error, session.ExitCode, now(), session.ID, node)
		if err != nil {
			log.Printf("inventory session update: %v", err)
			return
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
	h.mu.Lock()
	old := h.agents[node]
	h.agents[node] = a
	if old != nil {
		old.socket.Close()
	}
	h.mu.Unlock()
	log.Printf("node connected: %s", node)
	defer func() {
		h.mu.Lock()
		if h.agents[node] == a {
			delete(h.agents, node)
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
	for _, a := range h.attachments {
		if a.loginHash == hash {
			a.cancel()
		}
	}
}
func (h *Hub) closeOtherLogins(hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
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
	a := &attachment{id: randomID(), terminalID: t.ID, nodeID: t.NodeID, loginHash: l.Hash, browser: browser, cancel: cancel}
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
