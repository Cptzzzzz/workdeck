//go:build linux

package fileworker

import (
	"context"
	"encoding/hex"
	"time"

	"workdeck/internal/files"
)

func (s *Server) dispatchWatch(ctx context.Context, r request) (any, error) {
	var p struct {
		Handle    string   `json:"handle,omitempty"`
		Paths     []string `json:"paths,omitempty"`
		TimeoutMS int      `json:"timeout_ms,omitempty"`
	}
	if err := decode(r.Params, &p); err != nil {
		return nil, err
	}
	if r.Method == "watch.open" {
		_, hexErr := hex.DecodeString(p.Handle)
		if len(p.Handle) != 48 || hexErr != nil || p.TimeoutMS != 0 {
			return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听参数无效"}
		}
		watch, err := s.engine.NewDirectoryWatch(ctx, r.WorkspaceID, r.Revision, p.Paths)
		if err != nil {
			return nil, err
		}
		handle := p.Handle
		s.mu.Lock()
		if s.closing || ctx.Err() != nil || len(s.watches) >= 32 || s.watches[handle].watch != nil {
			s.mu.Unlock()
			watch.Close()
			return nil, &files.Error{Code: "BUSY", Message: "监听数量已达上限或连接已关闭"}
		}
		s.watches[handle] = watchHandle{workspace: r.WorkspaceID, revision: r.Revision, watch: watch}
		s.mu.Unlock()
		return map[string]any{"handle": handle}, nil
	}
	if p.Handle == "" {
		return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听标识无效"}
	}
	if r.Method == "watch.close" && (len(p.Paths) != 0 || p.TimeoutMS != 0) {
		return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听参数无效"}
	}
	s.mu.Lock()
	item, ok := s.watches[p.Handle]
	if ok && r.Method == "watch.close" && item.workspace == r.WorkspaceID && item.revision == r.Revision {
		delete(s.watches, p.Handle)
	}
	s.mu.Unlock()
	if !ok || item.workspace != r.WorkspaceID || item.revision != r.Revision {
		return nil, &files.Error{Code: "NOT_FOUND", Message: "监听已关闭"}
	}
	switch r.Method {
	case "watch.set":
		if p.TimeoutMS != 0 {
			return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听参数无效"}
		}
		return nil, item.watch.Set(ctx, p.Paths)
	case "watch.poll":
		if len(p.Paths) != 0 || p.TimeoutMS < 0 || p.TimeoutMS > 10000 {
			return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听等待时间无效"}
		}
		return item.watch.Wait(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
	case "watch.close":
		if len(p.Paths) != 0 || p.TimeoutMS != 0 {
			return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听参数无效"}
		}
		return nil, item.watch.Close()
	}
	return nil, &files.Error{Code: "INVALID_REQUEST", Message: "监听请求无效"}
}
