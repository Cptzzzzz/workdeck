// Package fileworker serves a private, bounded RPC stream for one OS account.
// It does not listen on a network socket or manage terminal processes.
package fileworker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"workdeck/internal/files"
)

const maxRequest = 64 << 10

type request struct {
	ID          string          `json:"id"`
	Method      string          `json:"method"`
	WorkspaceID string          `json:"workspace_id,omitempty"`
	Revision    int64           `json:"root_revision,omitempty"`
	Params      json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     string       `json:"id"`
	Result any          `json:"result,omitempty"`
	Error  *files.Error `json:"error,omitempty"`
}

type Server struct {
	engine        *files.Engine
	mu            sync.Mutex
	readers       map[string]readHandle
	snapshots     map[string]directorySnapshot
	snapshotBytes int
	closing       bool
	active        map[string]*activeRequest
	writeMu       sync.Mutex
	workers       sync.WaitGroup
	slots         chan struct{}
}

type readHandle struct {
	workspace string
	revision  int64
	reader    *files.Reader
}

type activeRequest struct {
	stop context.CancelFunc
	done chan struct{}
}

func New(engine *files.Engine) *Server {
	return &Server{engine: engine, readers: make(map[string]readHandle), snapshots: make(map[string]directorySnapshot), active: make(map[string]*activeRequest), slots: make(chan struct{}, 16)}
}

func (s *Server) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer func() {
		cancel()
		// The peer has detached; unblock any response writer before waiting.
		if closer, ok := output.(io.Closer); ok {
			_ = closer.Close()
		}
		s.mu.Lock()
		s.closing = true
		readers := s.readers
		s.readers = make(map[string]readHandle)
		s.mu.Unlock()
		for _, handle := range readers {
			_ = handle.reader.Close()
		}
		s.workers.Wait()
	}()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maxRequest)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil || req.ID == "" || len(req.ID) > 128 || len(req.Method) > 64 {
			return errors.New("invalid file worker request")
		}
		if req.Method == "request.cancel" {
			var p struct {
				Target string `json:"target"`
			}
			if decode(req.Params, &p) != nil || p.Target == "" || len(p.Target) > 128 {
				return errors.New("invalid cancellation")
			}
			s.mu.Lock()
			target := s.active[p.Target]
			s.mu.Unlock()
			if target != nil {
				target.stop()
			}
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				if target != nil {
					select {
					case <-target.done:
					case <-ctx.Done():
						return
					}
				}
				_ = s.write(output, response{ID: req.ID})
			}()
			continue
		}
		callCtx, stop := context.WithTimeout(ctx, 30*time.Second)
		s.mu.Lock()
		if s.active[req.ID] != nil {
			s.mu.Unlock()
			stop()
			return errors.New("duplicate active request ID")
		}
		active := &activeRequest{stop: stop, done: make(chan struct{})}
		s.active[req.ID] = active
		s.mu.Unlock()
		// Closing a reader cannot be starved by blocked root-change requests.
		if req.Method != "read.close" {
			select {
			case s.slots <- struct{}{}:
			default:
				stop()
				s.mu.Lock()
				delete(s.active, req.ID)
				s.mu.Unlock()
				close(active.done)
				if err := s.write(output, response{ID: req.ID, Error: &files.Error{Code: "BUSY", Message: "文件服务繁忙，请稍后重试"}}); err != nil {
					return err
				}
				continue
			}
		}
		s.workers.Add(1)
		go func() {
			defer s.workers.Done()
			defer func() {
				s.mu.Lock()
				delete(s.active, req.ID)
				s.mu.Unlock()
				close(active.done)
				if req.Method != "read.close" {
					<-s.slots
				}
			}()
			defer stop()
			result, err := s.dispatch(callCtx, req)
			res := response{ID: req.ID, Result: result}
			if err != nil {
				var detail *files.Error
				if errors.As(err, &detail) {
					res.Error = detail
				} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					res.Error = &files.Error{Code: "CANCELED", Message: "文件操作已取消或超时"}
				} else {
					res.Error = &files.Error{Code: "IO_ERROR", Message: "文件操作失败，请检查节点权限或存储状态"}
				}
			}
			if err := s.write(output, res); err != nil {
				cancel()
				if closer, ok := input.(io.Closer); ok {
					_ = closer.Close()
				}
			}
		}()
	}
	return scanner.Err()
}

func (s *Server) write(output io.Writer, res response) error {
	data, err := json.Marshal(res)
	if err != nil {
		return err
	}
	if len(data) >= maxRequest {
		return fmt.Errorf("file worker response exceeds limit")
	}
	data = append(data, '\n')
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := output.Write(data)
	if err == nil && n != len(data) {
		return io.ErrShortWrite
	}
	return err
}

func decode(raw json.RawMessage, value any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return &files.Error{Code: "INVALID_REQUEST", Message: "文件请求参数无效"}
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return &files.Error{Code: "INVALID_REQUEST", Message: "文件请求参数无效"}
	}
	return nil
}

func (s *Server) dispatch(ctx context.Context, r request) (any, error) {
	switch r.Method {
	case "workspace.register":
		var p files.Workspace
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.RegisterWorkspace(ctx, p)
	case "workspace.identity":
		var p struct {
			TerminalID string `json:"terminal_id"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.WorkspaceIdentity(ctx, r.WorkspaceID, p.TerminalID)
	case "workspace.prepare":
		var p struct {
			OpID string `json:"op_id"`
			Root string `json:"root_path"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.PrepareRootChange(ctx, r.WorkspaceID, r.Revision, p.OpID, p.Root)
	case "workspace.commit", "workspace.abort", "workspace.status":
		var p struct {
			OpID string `json:"op_id"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		switch r.Method {
		case "workspace.commit":
			return s.engine.CommitRootChange(ctx, r.WorkspaceID, p.OpID)
		case "workspace.abort":
			return s.engine.AbortRootChange(ctx, r.WorkspaceID, p.OpID)
		default:
			return s.engine.RootChangeStatus(ctx, r.WorkspaceID, p.OpID)
		}
	case "directory.list":
		var p struct {
			Path     string `json:"path"`
			Hidden   bool   `json:"hidden"`
			Filter   string `json:"filter"`
			Snapshot string `json:"snapshot,omitempty"`
			Offset   int    `json:"offset,omitempty"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.listPage(ctx, r, directoryQuery{Path: p.Path, Hidden: p.Hidden, Filter: p.Filter, Snapshot: p.Snapshot, Offset: p.Offset})
	case "directory.create":
		var p struct {
			OpID string `json:"op_id"`
			Path string `json:"path"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.CreateDirectory(ctx, r.WorkspaceID, r.Revision, p.OpID, p.Path)
	case "entry.rename":
		var p struct {
			OpID    string `json:"op_id"`
			Source  string `json:"source"`
			Target  string `json:"target"`
			Version string `json:"version"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.Rename(ctx, r.WorkspaceID, r.Revision, p.OpID, p.Source, p.Target, p.Version)
	case "operation.status":
		var p struct {
			OpID string `json:"op_id"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		result, err := s.engine.Status(ctx, r.WorkspaceID, r.Revision, p.OpID)
		if files.ErrorCode(err) == "OPERATION_NOT_FOUND" {
			return s.engine.MutationStatus(ctx, r.WorkspaceID, r.Revision, p.OpID)
		}
		return result, err
	case "file.stat":
		var p struct {
			Path string `json:"path"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.Stat(ctx, r.WorkspaceID, r.Revision, p.Path)
	case "read.open":
		var p struct {
			Handle  string `json:"handle"`
			Path    string `json:"path"`
			Version string `json:"version"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		if p.Handle == "" || len(p.Handle) > 128 {
			return nil, &files.Error{Code: "INVALID_REQUEST", Message: "文件读取标识无效"}
		}
		reader, err := s.engine.OpenRead(ctx, r.WorkspaceID, r.Revision, p.Path, p.Version)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, exists := s.readers[p.Handle]; exists || s.closing || ctx.Err() != nil || len(s.readers) >= 32 {
			reader.Close()
			return nil, &files.Error{Code: "BUSY", Message: "打开的文件读取过多或标识重复"}
		}
		s.readers[p.Handle] = readHandle{workspace: r.WorkspaceID, revision: r.Revision, reader: reader}
		return reader.Metadata, nil
	case "read.chunk":
		var p struct {
			Handle string `json:"handle"`
			Offset int64  `json:"offset"`
			Length int    `json:"length"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		s.mu.Lock()
		handle, ok := s.readers[p.Handle]
		s.mu.Unlock()
		if !ok {
			return nil, &files.Error{Code: "NOT_FOUND", Message: "文件读取已关闭"}
		}
		if handle.workspace != r.WorkspaceID || handle.revision != r.Revision {
			return nil, &files.Error{Code: "OPERATION_SCOPE", Message: "文件读取不属于当前工作区修订"}
		}
		return handle.reader.ReadAt(ctx, p.Offset, p.Length)
	case "read.close":
		var p struct {
			Handle string `json:"handle"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		s.mu.Lock()
		handle, ok := s.readers[p.Handle]
		if ok && (handle.workspace != r.WorkspaceID || handle.revision != r.Revision) {
			s.mu.Unlock()
			return nil, &files.Error{Code: "OPERATION_SCOPE", Message: "文件读取不属于当前工作区修订"}
		}
		delete(s.readers, p.Handle)
		s.mu.Unlock()
		if ok {
			return nil, handle.reader.Close()
		}
		return nil, nil
	case "write.begin":
		var p struct {
			OpID string          `json:"op_id"`
			Spec files.WriteSpec `json:"spec"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.BeginWrite(ctx, r.WorkspaceID, r.Revision, p.OpID, p.Spec)
	case "write.chunk":
		var p struct {
			OpID   string `json:"op_id"`
			Offset int64  `json:"offset"`
			Data   []byte `json:"data"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		return s.engine.Append(ctx, r.WorkspaceID, r.Revision, p.OpID, p.Offset, p.Data)
	case "write.commit", "write.abort", "write.status":
		var p struct {
			OpID string `json:"op_id"`
		}
		if err := decode(r.Params, &p); err != nil {
			return nil, err
		}
		switch r.Method {
		case "write.commit":
			return s.engine.Commit(ctx, r.WorkspaceID, r.Revision, p.OpID)
		case "write.abort":
			return s.engine.Abort(ctx, r.WorkspaceID, r.Revision, p.OpID)
		default:
			return s.engine.Status(ctx, r.WorkspaceID, r.Revision, p.OpID)
		}
	default:
		return nil, &files.Error{Code: "UNKNOWN_OPERATION", Message: "不支持此文件操作"}
	}
}

// Run owns the engine for this process; callers control the input lifetime.
func Run(ctx context.Context, dir string, input io.Reader, output io.Writer) error {
	engine, err := files.Open(dir)
	if err != nil {
		return err
	}
	defer engine.Close()
	return New(engine).Serve(ctx, input, output)
}
