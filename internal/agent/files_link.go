package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/fileprotocol"
	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func (a *Agent) attachFiles(parent context.Context, pool *fileWorkerPool, msg protocol.Message) error {
	if !validID(msg.TerminalID) || !validID(msg.WorkspaceID) || !validID(msg.Ticket) || msg.RootRevision < 1 {
		return errors.New("invalid file attachment")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	worker, err := pool.forTerminal(ctx, msg.TerminalID)
	if err != nil {
		return err
	}
	var identity files.Workspace
	if err = worker.Call(ctx, "workspace.identity", msg.WorkspaceID, 0, map[string]any{"terminal_id": msg.TerminalID}, &identity); err != nil {
		return err
	}
	if identity.ID != msg.WorkspaceID || identity.TerminalID != msg.TerminalID || identity.Revision != msg.RootRevision {
		return errors.New("stale file attachment")
	}
	socket, err := a.dial("/api/agent/files", msg.Ticket)
	if err != nil {
		return err
	}
	defer socket.Close()
	socket.SetReadLiveness(fileprotocol.HeaderSize + fileprotocol.MaxChunk)
	go func() { <-ctx.Done(); socket.Close() }()
	done := make(chan struct{})
	defer close(done)
	go socket.Heartbeat(done)
	link := fileLink{ctx: ctx, worker: worker, socket: socket, workspace: msg.WorkspaceID, terminal: msg.TerminalID, revision: msg.RootRevision, readers: make(map[string]string), uploads: make(map[string]bool)}
	defer func() { cancel(); link.closeReaders() }()
	if err = link.send(files.NewID(time.Now()), "file.ready", map[string]any{"node_time_ms": time.Now().UnixMilli(), "route": "relay"}, nil); err != nil {
		return err
	}
	type packet struct {
		kind int
		data []byte
	}
	packets := make(chan packet, 8)
	go func() {
		defer cancel()
		for {
			kind, data, err := socket.Conn.ReadMessage()
			if err != nil {
				return
			}
			select {
			case packets <- packet{kind, data}:
			case <-ctx.Done():
				return
			default:
				return // bounded queue; a sender must await acknowledgements
			}
		}
	}()
	for {
		var frame packet
		select {
		case frame = <-packets:
		case <-ctx.Done():
			return ctx.Err()
		}
		kind, data := frame.kind, frame.data
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if kind == websocket.TextMessage {
			request, err := fileprotocol.DecodeControl(data)
			if err != nil {
				return err
			}
			if request.WorkspaceID != link.workspace || request.RootRevision != link.revision || request.RouteEpoch != 1 {
				return fileprotocol.ErrFrame
			}
			if err = link.control(request); err != nil {
				return err
			}
		} else if kind == websocket.BinaryMessage {
			chunk, err := fileprotocol.DecodeChunk(data, fileprotocol.UploadChunk)
			if err != nil || chunk.RouteEpoch != 1 {
				return fileprotocol.ErrFrame
			}
			if err = link.upload(chunk); err != nil {
				return err
			}
		} else {
			return fileprotocol.ErrFrame
		}
	}
}

type fileLink struct {
	ctx                 context.Context
	worker              *fileWorkerClient
	socket              *protocol.Socket
	workspace, terminal string
	revision            int64
	readers             map[string]string // browser read request ID -> private worker handle
	uploads             map[string]bool
}

func fileParams(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil {
		return fileprotocol.ErrFrame
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fileprotocol.ErrFrame
	}
	return nil
}
func (l *fileLink) call(method string, params any, result any) error {
	if err := l.ctx.Err(); err != nil {
		return err
	}
	var identity files.Workspace
	if err := l.worker.Call(l.ctx, "workspace.identity", l.workspace, 0, map[string]any{"terminal_id": l.terminal}, &identity); err != nil {
		return err
	}
	if identity.ID != l.workspace || identity.TerminalID != l.terminal || identity.Revision != l.revision {
		return &files.Error{Code: "STALE_WORKSPACE", Message: "工作区根目录已改变"}
	}
	if err := l.ctx.Err(); err != nil {
		return err
	}
	return l.worker.Call(l.ctx, method, l.workspace, l.revision, params, result)
}
func (l *fileLink) send(id, kind string, value any, err error) error {
	payload := struct {
		Result any          `json:"result,omitempty"`
		Error  *files.Error `json:"error,omitempty"`
	}{Result: value}
	if err != nil {
		payload.Result = nil
		var detail *files.Error
		if errors.As(err, &detail) {
			payload.Error = detail
		} else {
			payload.Error = &files.Error{Code: "IO_ERROR", Message: "节点文件操作失败"}
		}
	}
	raw, e := json.Marshal(payload)
	if e != nil {
		return e
	}
	encoded, e := fileprotocol.EncodeControl(fileprotocol.Envelope{Version: 1, Type: kind, RequestID: id, WorkspaceID: l.workspace, RootRevision: l.revision, RouteEpoch: 1, Payload: raw})
	if e != nil {
		return e
	}
	if l.ctx.Err() != nil {
		return l.ctx.Err()
	}
	return l.socket.Write(websocket.TextMessage, encoded)
}
func (l *fileLink) control(request fileprotocol.Envelope) error {
	id := request.RequestID
	switch request.Type {
	case "directory.list", "file.stat":
		var result json.RawMessage
		err := l.call(request.Type, request.Payload, &result)
		return l.send(id, "result", result, err)
	case "file.read.open":
		var p struct {
			Path    string `json:"path"`
			Version string `json:"version"`
		}
		if err := fileParams(request.Payload, &p); err != nil {
			return l.send(id, "result", nil, err)
		}
		if len(l.readers) >= 8 || l.readers[id] != "" {
			return l.send(id, "result", nil, &files.Error{Code: "BUSY", Message: "文件读取过多或标识重复"})
		}
		handle := files.NewID(time.Now())
		var result files.Entry
		err := l.call("read.open", map[string]any{"handle": handle, "path": p.Path, "version": p.Version}, &result)
		if err == nil {
			l.readers[id] = handle
		} else {
			// A canceled open may have completed before its response was lost.
			// Call waits for the worker cancellation barrier before returning.
			cleanup, stop := context.WithTimeout(context.Background(), 2*time.Second)
			_ = l.worker.Call(cleanup, "read.close", l.workspace, l.revision, map[string]any{"handle": handle}, nil)
			stop()
		}
		return l.send(id, "result", result, err)
	case "file.read.chunk":
		var p struct {
			ReadID string `json:"read_id"`
			Offset int64  `json:"offset"`
			Length int    `json:"length"`
		}
		if err := fileParams(request.Payload, &p); err != nil {
			return l.send(id, "result", nil, err)
		}
		handle := l.readers[p.ReadID]
		if handle == "" {
			return l.send(id, "result", nil, &files.Error{Code: "NOT_FOUND", Message: "文件读取已关闭"})
		}
		var data []byte
		err := l.call("read.chunk", map[string]any{"handle": handle, "offset": p.Offset, "length": p.Length}, &data)
		if err == nil && len(data) > 0 {
			encoded, e := fileprotocol.EncodeChunk(fileprotocol.Chunk{Kind: fileprotocol.DownloadChunk, RequestID: id, Offset: p.Offset, RouteEpoch: 1, Data: data})
			if e != nil {
				return e
			}
			if e = l.socket.Write(websocket.BinaryMessage, encoded); e != nil {
				return e
			}
		}
		return l.send(id, "result", map[string]any{"bytes": len(data)}, err)
	case "file.read.close":
		var p struct {
			ReadID string `json:"read_id"`
		}
		if err := fileParams(request.Payload, &p); err != nil {
			return l.send(id, "result", nil, err)
		}
		handle := l.readers[p.ReadID]
		if handle == "" {
			return l.send(id, "result", nil, nil)
		}
		err := l.call("read.close", map[string]any{"handle": handle}, nil)
		if err == nil {
			delete(l.readers, p.ReadID)
		}
		return l.send(id, "result", nil, err)
	case "file.write.begin":
		var p struct {
			OpID string          `json:"op_id"`
			Spec files.WriteSpec `json:"spec"`
		}
		if err := fileParams(request.Payload, &p); err != nil {
			return l.send(id, "result", nil, err)
		}
		if len(l.uploads) >= 8 && !l.uploads[p.OpID] {
			return l.send(id, "result", nil, &files.Error{Code: "BUSY", Message: "同时保存的文件过多"})
		}
		var result files.Operation
		err := l.call("write.begin", p, &result)
		if err == nil && (result.State == "receiving" || result.State == "ready") {
			l.uploads[p.OpID] = true
		}
		return l.send(id, "result", result, err)
	case "file.write.commit", "file.write.abort", "operation.status":
		var p struct {
			OpID string `json:"op_id"`
		}
		if err := fileParams(request.Payload, &p); err != nil {
			return l.send(id, "result", nil, err)
		}
		method := "write.status"
		if request.Type == "file.write.commit" {
			method = "write.commit"
		}
		if request.Type == "file.write.abort" {
			method = "write.abort"
		}
		if request.Type != "operation.status" && !l.uploads[p.OpID] {
			return l.send(id, "result", nil, &files.Error{Code: "OPERATION_SCOPE", Message: "请先恢复此文件上传"})
		}
		var result files.Operation
		err := l.call(method, p, &result)
		if err == nil && (result.State == "committed" || result.State == "aborted") {
			delete(l.uploads, p.OpID)
		}
		return l.send(id, "result", result, err)
	default:
		return l.send(id, "result", nil, &files.Error{Code: "UNKNOWN_OPERATION", Message: "不支持此文件操作"})
	}
}
func (l *fileLink) upload(chunk fileprotocol.Chunk) error {
	if !l.uploads[chunk.RequestID] {
		return l.send(chunk.RequestID, "file.write.progress", nil, &files.Error{Code: "OPERATION_SCOPE", Message: "请先开始或恢复此文件上传"})
	}
	var result files.Operation
	err := l.call("write.chunk", map[string]any{"op_id": chunk.RequestID, "offset": chunk.Offset, "data": chunk.Data}, &result)
	return l.send(chunk.RequestID, "file.write.progress", result, err)
}
func (l *fileLink) closeReaders() {
	for _, handle := range l.readers {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = l.worker.Call(ctx, "read.close", l.workspace, l.revision, map[string]any{"handle": handle}, nil)
		cancel()
	}
}
