package hub

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"workdeck/internal/fileprotocol"
	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

type downloadInput struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Size    int64  `json:"size"`
}

// Only one byte range is supported; each response remains bound to the
// originally authorized file version and size.
func downloadRange(header string, size int64) (int64, int64, bool) {
	if size <= 0 || !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") {
		return 0, 0, false
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(parts) != 2 || (parts[0] == "" && parts[1] == "") || strings.Trim(parts[0], "0123456789") != "" || strings.Trim(parts[1], "0123456789") != "" {
		return 0, 0, false
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size, true
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return 0, 0, false
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end + 1, true
}

func (h *Hub) newDownloadTicket(w http.ResponseWriter, r *http.Request, l login) {
	var input downloadInput
	if !decode(w, r, &input) {
		return
	}
	_, hexErr := hex.DecodeString(input.Version)
	if len(input.Version) != 64 || hexErr != nil || input.Version != strings.ToLower(input.Version) || input.Size < 0 || input.Size > 1<<40 ||
		len(input.Path) == 0 || len(input.Path) > 4096 || !utf8.ValidString(input.Path) || strings.ContainsAny(input.Path, "\x00\r\n") || strings.HasPrefix(input.Path, "/") || path.Clean(input.Path) != input.Path || input.Path == "." || input.Path == ".." || strings.HasPrefix(input.Path, "../") {
		failure(w, 400, "下载参数无效")
		return
	}
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
	token := randomID()
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
	h.fileTickets[digest(token)] = &fileBrowserTicket{workspaceID: workspace.ID, terminalID: workspace.TerminalID, nodeID: workspace.NodeID, loginHash: l.Hash, revision: workspace.Revision, agent: agent, expires: now.Add(30 * time.Second), mode: "download", path: input.Path, version: input.Version, size: input.Size}
	h.mu.Unlock()
	respond(w, 200, map[string]any{"ticket": token, "expires_in": 30})
}

func (h *Hub) downloadFile(w http.ResponseWriter, r *http.Request, l login) {
	token := r.PathValue("ticket")
	if validateID(token) != nil {
		failure(w, 403, "下载凭证无效")
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
	tokenHash := digest(token)
	rangeHeader := r.Header.Get("Range")
	isResume := rangeHeader != ""
	var ticket *fileBrowserTicket
	if isResume {
		ticket = h.downloadResumes[tokenHash]
	} else {
		ticket = h.fileTickets[tokenHash]
	}
	if ticket == nil || ticket.mode != "download" || ticket.workspaceID != workspace.ID || ticket.terminalID != workspace.TerminalID || ticket.nodeID != workspace.NodeID || ticket.revision != workspace.Revision || ticket.loginHash != l.Hash || !ticket.expires.After(time.Now()) || h.agents[workspace.NodeID] != ticket.agent {
		h.mu.Unlock()
		h.authMu.Unlock()
		lock.Unlock()
		failure(w, 403, "下载凭证失效")
		return
	}
	if !isResume {
		delete(h.fileTickets, tokenHash)
	}
	start, end := int64(0), ticket.size
	if isResume {
		var valid bool
		start, end, valid = downloadRange(rangeHeader, ticket.size)
		if !valid {
			h.mu.Unlock()
			h.authMu.Unlock()
			lock.Unlock()
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", ticket.size))
			failure(w, http.StatusRequestedRangeNotSatisfiable, "下载范围无效")
			return
		}
		if value := r.Header.Get("If-Range"); value != "" && value != `"`+ticket.version+`"` {
			h.mu.Unlock()
			h.authMu.Unlock()
			lock.Unlock()
			failure(w, http.StatusPreconditionFailed, "下载版本不匹配")
			return
		}
	}
	if h.fileConnections == nil {
		h.fileConnections = make(map[string]*fileConnection)
	}
	if h.filePending == nil {
		h.filePending = make(map[string]*fileAgentTicket)
	}
	count := 0
	for _, c := range h.fileConnections {
		if c.loginHash == l.Hash {
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
	if !isResume {
		if h.downloadResumes == nil {
			h.downloadResumes = make(map[string]*fileBrowserTicket)
		}
		now := time.Now()
		h.removeFileTicketsLocked(func(t *fileBrowserTicket) bool { return !t.expires.After(now) })
		// Bound retained credentials independently of short-lived connect tickets.
		for len(h.downloadResumes) >= 1024 {
			var oldest string
			var expiry time.Time
			for id, item := range h.downloadResumes {
				if oldest == "" || item.expires.Before(expiry) {
					oldest, expiry = id, item.expires
				}
			}
			delete(h.downloadResumes, oldest)
		}
		resume := *ticket
		resume.expires = now.Add(time.Hour)
		h.downloadResumes[tokenHash] = &resume
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
	if err := c.agent.socket.JSON(protocol.Message{Type: "file.attach", TerminalID: c.terminalID, WorkspaceID: c.workspaceID, RootRevision: c.revision, Ticket: agentToken}); err != nil {
		failure(w, 502, "节点连接失败")
		return
	}
	var node *protocol.Socket
	select {
	case node = <-pending.channel:
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
		failure(w, 504, "节点连接超时")
		return
	}
	defer node.Close()
	go func() { <-ctx.Done(); node.Close() }()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				alive := h.loginAlive(c.loginHash)
				h.mu.Lock()
				alive = alive && h.agents[c.nodeID] == c.agent
				h.mu.Unlock()
				if !alive {
					cancel()
					return
				}
			}
		}
	}()
	done := make(chan struct{})
	defer close(done)
	go node.Heartbeat(done)
	reader := downloadReader{socket: node, workspace: c.workspaceID, revision: c.revision}
	if err := reader.ready(); err != nil {
		failure(w, 502, "节点文件连接失败")
		return
	}
	readID := files.NewID(time.Now())
	var meta files.Entry
	if err := reader.control(readID, "file.read.open", map[string]any{"path": ticket.path, "version": ticket.version}, &meta); err != nil {
		failure(w, 409, "文件已改变或无法读取，请重新下载")
		return
	}
	if meta.Kind != "file" || meta.Restricted || meta.Version != ticket.version || meta.Size != ticket.size {
		failure(w, 409, "文件版本或大小已改变，请重新下载")
		return
	}
	name := path.Base(ticket.path)
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	if disposition == "" {
		disposition = `attachment; filename="download"`
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Content-Length", strconv.FormatInt(end-start, 10))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", `"`+ticket.version+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if isResume {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, meta.Size))
		w.WriteHeader(http.StatusPartialContent)
	}
	for offset := start; offset < end; {
		if ctx.Err() != nil {
			return
		}
		length := int(min(int64(fileprotocol.MaxChunk), end-offset))
		data, err := reader.chunk(readID, offset, length)
		if err != nil || len(data) != length {
			return
		}
		if n, err := w.Write(data); err != nil || n != len(data) {
			return
		}
		offset += int64(len(data))
	}
}

type downloadReader struct {
	socket    *protocol.Socket
	workspace string
	revision  int64
}

func (d *downloadReader) ready() error {
	kind, data, err := d.socket.Conn.ReadMessage()
	if err != nil || kind != websocket.TextMessage {
		return fileprotocol.ErrFrame
	}
	e, err := fileprotocol.DecodeControl(data)
	if err != nil || e.Type != "file.ready" || e.WorkspaceID != d.workspace || e.RootRevision != d.revision || e.RouteEpoch != 1 {
		return fileprotocol.ErrFrame
	}
	return nil
}
func (d *downloadReader) send(id, kind string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame, err := fileprotocol.EncodeControl(fileprotocol.Envelope{Version: 1, Type: kind, RequestID: id, WorkspaceID: d.workspace, RootRevision: d.revision, RouteEpoch: 1, Payload: raw})
	if err != nil {
		return err
	}
	return d.socket.Write(websocket.TextMessage, frame)
}
func (d *downloadReader) receive(id string, out any) error {
	kind, data, err := d.socket.Conn.ReadMessage()
	if err != nil || kind != websocket.TextMessage {
		return fileprotocol.ErrFrame
	}
	e, err := fileprotocol.DecodeControl(data)
	if err != nil || e.Type != "result" || e.RequestID != id || e.WorkspaceID != d.workspace || e.RootRevision != d.revision || e.RouteEpoch != 1 {
		return fileprotocol.ErrFrame
	}
	var result struct {
		Result json.RawMessage `json:"result"`
		Error  *files.Error    `json:"error"`
	}
	if json.Unmarshal(e.Payload, &result) != nil {
		return fileprotocol.ErrFrame
	}
	if result.Error != nil {
		return result.Error
	}
	if out != nil && json.Unmarshal(result.Result, out) != nil {
		return fileprotocol.ErrFrame
	}
	return nil
}
func (d *downloadReader) control(id, kind string, params any, out any) error {
	if err := d.send(id, kind, params); err != nil {
		return err
	}
	return d.receive(id, out)
}
func (d *downloadReader) chunk(readID string, offset int64, length int) ([]byte, error) {
	id := files.NewID(time.Now())
	if err := d.send(id, "file.read.chunk", map[string]any{"read_id": readID, "offset": offset, "length": length}); err != nil {
		return nil, err
	}
	kind, data, err := d.socket.Conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if kind == websocket.TextMessage {
		return nil, fmt.Errorf("read failed")
	}
	if kind != websocket.BinaryMessage {
		return nil, fileprotocol.ErrFrame
	}
	chunk, err := fileprotocol.DecodeChunk(data, fileprotocol.DownloadChunk)
	if err != nil || chunk.RequestID != id || chunk.Offset != offset || chunk.RouteEpoch != 1 || len(chunk.Data) != length {
		return nil, fileprotocol.ErrFrame
	}
	var result struct {
		Bytes int `json:"bytes"`
	}
	if err = d.receive(id, &result); err != nil || result.Bytes != len(chunk.Data) {
		return nil, fileprotocol.ErrFrame
	}
	return chunk.Data, nil
}
