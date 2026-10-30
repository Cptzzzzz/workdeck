//go:build linux

package fileworker

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workdeck/internal/files"
)

func TestWatchRPCScopesHandlesAndCleansUp(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, filepath.Join(base, "state"), inR, outW); outW.Close() }()
	t.Cleanup(func() { inW.Close(); outR.Close(); cancel(); <-done })
	c := &client{in: inW, out: bufio.NewReader(outR)}
	w := files.Workspace{ID: files.NewID(time.Now()), TerminalID: files.NewID(time.Now()), Root: root, Revision: 1}
	if _, e := c.call(t, "workspace.register", "", 0, w); e != nil {
		t.Fatal(e)
	}
	handle := files.NewID(time.Now())
	if _, e := c.call(t, "watch.open", w.ID, 1, map[string]any{"handle": handle, "paths": []string{"."}}); e != nil {
		t.Fatal(e)
	}
	if _, e := c.call(t, "watch.poll", w.ID, 2, map[string]any{"handle": handle, "timeout_ms": 1}); e == nil || e.Code != "NOT_FOUND" {
		t.Fatalf("cross revision: %v", e)
	}
	if _, e := c.call(t, "watch.close", w.ID, 1, map[string]any{"handle": handle, "paths": []string{"."}}); e == nil || e.Code != "INVALID_REQUEST" {
		t.Fatalf("invalid close: %v", e)
	}
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, e := c.call(t, "watch.poll", w.ID, 1, map[string]any{"handle": handle, "timeout_ms": 1000})
	if e != nil {
		t.Fatal(e)
	}
	var event files.WatchEvent
	if err := json.Unmarshal(raw, &event); err != nil || !event.Changed || event.Reset {
		t.Fatalf("event: %+v %v", event, err)
	}
	if _, e := c.call(t, "watch.close", w.ID, 1, map[string]any{"handle": handle}); e != nil {
		t.Fatal(e)
	}
	if _, e := c.call(t, "watch.poll", w.ID, 1, map[string]any{"handle": handle, "timeout_ms": 1}); e == nil || e.Code != "NOT_FOUND" {
		t.Fatalf("closed: %v", e)
	}
}

func TestWatchWaitsDoNotStarveFileRequests(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	engine, err := files.Open(filepath.Join(base, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	workspace := files.Workspace{ID: files.NewID(time.Now()), TerminalID: files.NewID(time.Now()), Root: root, Revision: 1}
	if _, err := engine.RegisterWorkspace(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	server := New(engine)
	handles := make([]string, 16)
	for i := range handles {
		handles[i] = files.NewID(time.Now())
		params, _ := json.Marshal(map[string]any{"handle": handles[i], "paths": []string{"."}})
		if _, err := server.dispatchWatch(context.Background(), request{Method: "watch.open", WorkspaceID: workspace.ID, Revision: 1, Params: params}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, inR, outW) }()
	defer func() { cancel(); inW.Close(); outR.Close(); <-done }()
	encoder := json.NewEncoder(inW)
	for _, handle := range handles {
		params, _ := json.Marshal(map[string]any{"handle": handle, "timeout_ms": 4000})
		if err := encoder.Encode(request{ID: handle, Method: "watch.poll", WorkspaceID: workspace.ID, Revision: 1, Params: params}); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(server.watchSlots) != len(handles) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(server.watchSlots) != len(handles) {
		t.Fatal("watch requests did not start")
	}
	params, _ := json.Marshal(map[string]any{"path": "file"})
	if err := encoder.Encode(request{ID: "stat", Method: "file.stat", WorkspaceID: workspace.ID, Revision: 1, Params: params}); err != nil {
		t.Fatal(err)
	}
	response := make(chan []byte, 1)
	go func() { line, _ := bufio.NewReader(outR).ReadBytes('\n'); response <- line }()
	select {
	case line := <-response:
		var result struct {
			ID    string       `json:"id"`
			Error *files.Error `json:"error"`
		}
		if err := json.Unmarshal(line, &result); err != nil || result.ID != "stat" || result.Error != nil {
			t.Fatalf("stat response: %s %v", line, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watch waits blocked the file request")
	}
}
