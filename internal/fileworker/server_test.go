package fileworker

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workdeck/internal/files"
)

type client struct {
	in       *io.PipeWriter
	out      *bufio.Reader
	sequence int
}

func (c *client) call(t *testing.T, method, workspace string, revision int64, params any) (json.RawMessage, *files.Error) {
	t.Helper()
	c.sequence++
	msg := map[string]any{"id": fmt.Sprint(c.sequence), "method": method, "workspace_id": workspace, "root_revision": revision, "params": params}
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.in.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := c.out.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *files.Error    `json:"error"`
	}
	if err = json.Unmarshal(line, &result); err != nil {
		t.Fatal(err)
	}
	if result.ID != fmt.Sprint(c.sequence) {
		t.Fatalf("wrong response: %+v", result)
	}
	return result.Result, result.Error
}

func TestWorkerRPCFileLifecycleAndScope(t *testing.T) {
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
	c := &client{in: inW, out: bufio.NewReader(outR)}
	workspace := files.Workspace{ID: files.NewID(time.Now()), TerminalID: files.NewID(time.Now()), Root: root, Revision: 1}
	_, errResp := c.call(t, "workspace.register", "", 0, workspace)
	if errResp != nil {
		t.Fatal(errResp)
	}
	body := []byte("hello workspace\n")
	sum := sha256.Sum256(body)
	id := files.NewID(time.Now())
	spec := files.WriteSpec{Path: "new.txt", Create: true, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
	_, errResp = c.call(t, "write.begin", workspace.ID, 1, map[string]any{"op_id": id, "spec": spec})
	if errResp != nil {
		t.Fatal(errResp)
	}
	_, errResp = c.call(t, "write.chunk", workspace.ID, 1, map[string]any{"op_id": id, "offset": 0, "data": body})
	if errResp != nil {
		t.Fatal(errResp)
	}
	result, errResp := c.call(t, "write.commit", workspace.ID, 1, map[string]any{"op_id": id})
	if errResp != nil {
		t.Fatal(errResp)
	}
	var operation files.Operation
	if err := json.Unmarshal(result, &operation); err != nil || operation.State != "committed" {
		t.Fatal(operation, err)
	}
	_, errResp = c.call(t, "read.open", workspace.ID, 1, map[string]any{"handle": "handle", "path": "new.txt", "version": operation.Version})
	if errResp != nil {
		t.Fatal(errResp)
	}
	_, errResp = c.call(t, "read.chunk", workspace.ID, 2, map[string]any{"handle": "handle", "offset": 0, "length": 20})
	if errResp == nil || errResp.Code != "OPERATION_SCOPE" {
		t.Fatal(errResp)
	}
	_, errResp = c.call(t, "read.close", workspace.ID, 2, map[string]any{"handle": "handle"})
	if errResp == nil || errResp.Code != "OPERATION_SCOPE" {
		t.Fatal(errResp)
	}
	result, errResp = c.call(t, "read.chunk", workspace.ID, 1, map[string]any{"handle": "handle", "offset": 0, "length": 20})
	if errResp != nil {
		t.Fatal(errResp)
	}
	var got []byte
	if err := json.Unmarshal(result, &got); err != nil || string(got) != string(body) {
		t.Fatal(string(got), err)
	}
	// EOF releases active read handles before the engine closes.
	inW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not shut down")
	}
	outR.Close()
	if b, err := os.ReadFile(filepath.Join(root, "new.txt")); err != nil || string(b) != string(body) {
		t.Fatal(string(b), err)
	}
}

func TestDirectoryPagesAreBoundedAndScoped(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 500; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%04d-<repeated-name>.txt", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	engine, err := files.Open(filepath.Join(base, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	w, err := engine.RegisterWorkspace(context.Background(), files.Workspace{ID: files.NewID(time.Now()), TerminalID: files.NewID(time.Now()), Root: root, Revision: 1})
	if err != nil {
		t.Fatal(err)
	}
	server := New(engine)
	request := request{ID: "test", WorkspaceID: w.ID, Revision: 1}
	query := directoryQuery{Path: ".", Hidden: true}
	total := 0
	pages := 0
	for {
		page, err := server.listPage(context.Background(), request, query)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(response{ID: request.ID, Result: page})
		if len(encoded) > 28<<10 {
			t.Fatalf("oversized page: %d", len(encoded))
		}
		total += len(page.Entries)
		pages++
		if !page.HasMore {
			break
		}
		query.Snapshot = page.Snapshot
		query.Offset = page.Next
	}
	if total != 500 || pages < 2 {
		t.Fatalf("count %d pages %d", total, pages)
	}
	request.Revision = 2
	_, err = server.listPage(context.Background(), request, query)
	if files.ErrorCode(err) != "OPERATION_SCOPE" {
		t.Fatalf("wrong scope: %v", err)
	}
	request.Revision = 1
	newRoot := filepath.Join(base, "new-root")
	if err := os.Mkdir(newRoot, 0700); err != nil {
		t.Fatal(err)
	}
	opID := files.NewID(time.Now())
	if _, err := engine.PrepareRootChange(context.Background(), w.ID, 1, opID, newRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.CommitRootChange(context.Background(), w.ID, opID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.listPage(context.Background(), request, query); files.ErrorCode(err) != "STALE_WORKSPACE" {
		t.Fatalf("old snapshot remained usable after root change: %v", err)
	}
}
