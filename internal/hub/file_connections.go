package hub

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/fileprotocol"
	"workdeck/internal/protocol"
)

const fileTicketProtocol = "workdeck-file-ticket."

type fileBrowserTicket struct {
	workspaceID, terminalID, nodeID, loginHash string
	revision                                   int64
	agent                                      *agentConn
	expires                                    time.Time
}
type fileAgentTicket struct {
	conn    *fileConnection
	channel chan *protocol.Socket
	expires time.Time
}
type fileConnection struct {
	id, workspaceID, terminalID, nodeID, loginHash string
	revision                                       int64
	agent                                          *agentConn
	ctx                                            context.Context
	cancel                                         context.CancelFunc
}

// All helpers ending in Locked require h.mu and never touch terminal state.
func (h *Hub) cancelFileConnectionsLocked(match func(*fileConnection) bool) {
	for _, c := range h.fileConnections {
		if match(c) {
			c.cancel()
		}
	}
}
func (h *Hub) removeFileTicketsLocked(match func(*fileBrowserTicket) bool) {
	for id, t := range h.fileTickets {
		if match(t) {
			delete(h.fileTickets, id)
		}
	}
}
func (h *Hub) revokeWorkspaceFiles(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cancelFileConnectionsLocked(func(c *fileConnection) bool { return c.workspaceID == id })
	h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return t.workspaceID == id })
}
func (h *Hub) loginAlive(hash string) bool {
	var expiry int64
	return h.store.db.QueryRow(`SELECT expires FROM logins WHERE hash=?`, hash).Scan(&expiry) == nil && expiry > time.Now().Unix()
}
func (h *Hub) newFileConnection(w http.ResponseWriter, r *http.Request, l login) {
	workspace, err := h.store.workspaceByID(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		failure(w, 404, "工作区不存在")
		return
	}
	if err != nil {
		failure(w, 500, "读取工作区失败")
		return
	}
	lock := h.workspaceLock(workspace.TerminalID)
	lock.Lock()
	defer lock.Unlock()
	workspace, err = h.store.workspaceByID(r.Context(), workspace.ID)
	if err != nil || workspace.State != "ready" {
		failure(w, 409, "工作区暂不可用")
		return
	}
	if !h.workspaceNodeCapability(workspace.NodeID, "workspace-files-v1") {
		failure(w, 409, "节点离线或尚不支持工作区")
		return
	}
	ticket := randomID()
	now := time.Now()
	h.authMu.Lock()
	defer h.authMu.Unlock()
	if !h.loginAlive(l.Hash) {
		failure(w, 401, "登录状态已失效")
		return
	}
	h.mu.Lock()
	if h.fileTickets == nil {
		h.fileTickets = make(map[string]*fileBrowserTicket)
	}
	h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return !t.expires.After(now) })
	count := 0
	for _, t := range h.fileTickets {
		if t.loginHash == l.Hash {
			count++
		}
	}
	agent := h.agents[workspace.NodeID]
	if agent == nil || len(h.fileTickets) >= 1024 || count >= 16 {
		h.mu.Unlock()
		failure(w, 429, "文件连接过多或节点已离线")
		return
	}
	h.fileTickets[digest(ticket)] = &fileBrowserTicket{workspaceID: workspace.ID, terminalID: workspace.TerminalID, nodeID: workspace.NodeID, loginHash: l.Hash, revision: workspace.Revision, agent: agent, expires: now.Add(15 * time.Second)}
	h.mu.Unlock()
	respond(w, 200, map[string]any{"ticket": ticket, "expires_in": 15})
}

func (h *Hub) browserFileSocket(w http.ResponseWriter, r *http.Request, l login) {
	offered := websocket.Subprotocols(r)
	if len(offered) != 1 || !strings.HasPrefix(offered[0], fileTicketProtocol) {
		failure(w, 403, "文件连接凭证无效")
		return
	}
	token := strings.TrimPrefix(offered[0], fileTicketProtocol)
	if validateID(token) != nil {
		failure(w, 403, "文件连接凭证无效")
		return
	}
	workspace, err := h.store.workspaceByID(r.Context(), r.PathValue("id"))
	if err != nil {
		failure(w, 404, "工作区不存在")
		return
	}
	lock := h.workspaceLock(workspace.TerminalID)
	lock.Lock()
	workspace, err = h.store.workspaceByID(r.Context(), workspace.ID)
	if err != nil || workspace.State != "ready" {
		lock.Unlock()
		failure(w, 409, "工作区暂不可用")
		return
	}
	h.authMu.Lock()
	if !h.loginAlive(l.Hash) {
		h.authMu.Unlock()
		lock.Unlock()
		failure(w, 401, "登录状态已失效")
		return
	}
	h.mu.Lock()
	ticket := h.fileTickets[digest(token)]
	delete(h.fileTickets, digest(token))
	if ticket == nil || ticket.workspaceID != workspace.ID || ticket.terminalID != workspace.TerminalID || ticket.nodeID != workspace.NodeID || ticket.revision != workspace.Revision || ticket.loginHash != l.Hash || !ticket.expires.After(time.Now()) || h.agents[workspace.NodeID] != ticket.agent {
		h.mu.Unlock()
		h.authMu.Unlock()
		lock.Unlock()
		failure(w, 403, "文件连接凭证失效")
		return
	}
	if h.fileConnections == nil {
		h.fileConnections = make(map[string]*fileConnection)
	}
	if h.filePending == nil {
		h.filePending = make(map[string]*fileAgentTicket)
	}
	count := 0
	for _, a := range h.fileConnections {
		if a.loginHash == l.Hash {
			count++
		}
	}
	if count >= 16 || len(h.fileConnections) >= 1024 {
		h.mu.Unlock()
		h.authMu.Unlock()
		lock.Unlock()
		failure(w, 429, "文件连接过多")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	c := &fileConnection{id: randomID(), workspaceID: workspace.ID, terminalID: workspace.TerminalID, nodeID: workspace.NodeID, loginHash: l.Hash, revision: workspace.Revision, agent: ticket.agent, ctx: ctx, cancel: cancel}
	agentToken := randomID()
	pending := &fileAgentTicket{conn: c, channel: make(chan *protocol.Socket, 1), expires: time.Now().Add(15 * time.Second)}
	h.fileConnections[c.id] = c
	h.filePending[digest(agentToken)] = pending
	h.mu.Unlock()
	h.authMu.Unlock()
	lock.Unlock()
	defer func() {
		cancel()
		h.mu.Lock()
		delete(h.fileConnections, c.id)
		delete(h.filePending, digest(agentToken))
		h.mu.Unlock()
	}()
	conn, err := (&websocket.Upgrader{Subprotocols: []string{offered[0]}, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == h.cfg.PublicURL }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	browser := &protocol.Socket{Conn: conn}
	defer browser.Close()
	browser.SetReadLiveness(fileprotocol.HeaderSize + fileprotocol.MaxChunk)
	go func() { <-ctx.Done(); browser.Close() }()
	if err = c.agent.socket.JSON(protocol.Message{Type: "file.attach", TerminalID: c.terminalID, WorkspaceID: c.workspaceID, RootRevision: c.revision, Ticket: agentToken}); err != nil {
		return
	}
	var node *protocol.Socket
	select {
	case node = <-pending.channel:
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
		return
	}
	defer node.Close()
	go func() { <-ctx.Done(); node.Close() }()
	done := make(chan struct{})
	defer close(done)
	go browser.Heartbeat(done)
	go node.Heartbeat(done)
	errorsCh := make(chan struct{}, 2)
	forward := func(from, to *protocol.Socket) {
		defer func() { errorsCh <- struct{}{} }()
		for {
			kind, data, e := from.Conn.ReadMessage()
			if e != nil {
				return
			}
			if kind != websocket.TextMessage && kind != websocket.BinaryMessage {
				return
			}
			if kind == websocket.TextMessage && len(data) > fileprotocol.MaxControl {
				return
			}
			if kind == websocket.BinaryMessage && len(data) > fileprotocol.HeaderSize+fileprotocol.MaxChunk {
				return
			}
			if ctx.Err() != nil {
				return
			}
			if to.Write(kind, data) != nil {
				return
			}
		}
	}
	go forward(browser, node)
	go forward(node, browser)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-errorsCh:
			return
		case <-ticker.C:
			alive := h.loginAlive(c.loginHash)
			h.mu.Lock()
			alive = alive && h.agents[c.nodeID] == c.agent
			h.mu.Unlock()
			if !alive {
				return
			}
		}
	}
}

func (h *Hub) agentFileSocket(w http.ResponseWriter, r *http.Request) {
	node, ok := h.agentIdentity(r)
	if !ok {
		failure(w, 401, "节点认证失败")
		return
	}
	token := r.Header.Get("X-Workdeck-Ticket")
	if validateID(token) != nil {
		failure(w, 403, "文件连接凭证无效")
		return
	}
	key := digest(token)
	h.mu.Lock()
	pending := h.filePending[key]
	delete(h.filePending, key)
	if pending == nil || pending.conn.nodeID != node || h.agents[node] != pending.conn.agent || !pending.expires.After(time.Now()) || pending.conn.ctx.Err() != nil {
		h.mu.Unlock()
		failure(w, 403, "文件连接凭证失效")
		return
	}
	h.mu.Unlock()
	conn, err := (&websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	socket := &protocol.Socket{Conn: conn}
	socket.SetReadLiveness(fileprotocol.HeaderSize + fileprotocol.MaxChunk)
	select {
	case pending.channel <- socket:
	case <-pending.conn.ctx.Done():
		socket.Close()
	}
}
