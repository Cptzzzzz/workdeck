package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"workdeck/internal/files"
	"workdeck/internal/protocol"
)

func testWorkerBinary(t *testing.T) string {
	t.Helper()
	if name := os.Getenv("WORKDECK_WORKER_TEST_BINARY"); name != "" {
		return name
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("Go compiler is required for the worker integration test")
	}
	binary := filepath.Join(t.TempDir(), "workdeck")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/workdeck")
	cmd.Dir = "../.."
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build isolated worker: %v: %s", err, output)
	}
	return binary
}

func testAgent(t *testing.T, owner string) (*Agent, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	id := files.NewID(time.Now())
	record := protocol.Session{ID: id, RunUser: owner, State: "running"}
	if err := atomicJSON(filepath.Join(dir, "sessions", id+".json"), record); err != nil {
		t.Fatal(err)
	}
	return &Agent{identity: Identity{NodeID: files.NewID(time.Now())}, sessions: &Sessions{dir: dir}, version: "dev"}, id
}

func TestFileWorkerPoolUsesIsolatedProcessAndPreservesTerminal(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is required")
	}
	binary := testWorkerBinary(t)
	account, err := serviceUser()
	if err != nil {
		t.Fatal(err)
	}
	a, terminalID := testAgent(t, account.Username)
	socket := "workdeck-worker-test-" + files.NewID(time.Now())
	tmux := func(args ...string) ([]byte, error) {
		return exec.Command("tmux", append([]string{"-L", socket}, args...)...).CombinedOutput()
	}
	if out, err := tmux("-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 120"); err != nil {
		t.Fatalf("start isolated tmux: %s %v", out, err)
	}
	defer tmux("kill-server")
	pid, err := tmux("display-message", "-p", "-t", "main", "#{pane_pid}")
	if err != nil {
		t.Fatal(err)
	}
	pool := newFileWorkerPool(a)
	pool.selfBinary = binary
	pool.statePath = func(_ *user.User, _ string) string { return filepath.Join(t.TempDir(), "state") }
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	worker, err := pool.forTerminal(ctx, terminalID)
	if err != nil {
		t.Fatal(err)
	}
	again, err := pool.forTerminal(ctx, terminalID)
	if err != nil || worker != again {
		t.Fatalf("worker reuse: %v", err)
	}
	root := t.TempDir()
	workspace := files.Workspace{ID: files.NewID(time.Now()), TerminalID: terminalID, Root: root, Revision: 1}
	var registered files.Workspace
	if err = worker.Call(ctx, "workspace.register", "", 0, workspace, &registered); err != nil {
		t.Fatal(err)
	}
	body := []byte("real isolated worker\n")
	sum := sha256.Sum256(body)
	opID := files.NewID(time.Now())
	spec := files.WriteSpec{Path: "main.go", Create: true, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
	var op files.Operation
	if err = worker.Call(ctx, "write.begin", workspace.ID, 1, map[string]any{"op_id": opID, "spec": spec}, &op); err != nil {
		t.Fatal(err)
	}
	if err = worker.Call(ctx, "write.chunk", workspace.ID, 1, map[string]any{"op_id": opID, "offset": 0, "data": body}, &op); err != nil {
		t.Fatal(err)
	}
	if err = worker.Call(ctx, "write.commit", workspace.ID, 1, map[string]any{"op_id": opID}, &op); err != nil || op.State != "committed" {
		t.Fatal(op, err)
	}
	var entry files.Entry
	if err = worker.Call(ctx, "read.open", workspace.ID, 1, map[string]any{"handle": "test", "path": "main.go", "version": op.Version}, &entry); err != nil {
		t.Fatal(err)
	}
	var content []byte
	if err = worker.Call(ctx, "read.chunk", workspace.ID, 1, map[string]any{"handle": "test", "offset": 0, "length": 32}, &content); err != nil || string(content) != string(body) {
		t.Fatal(string(content), err)
	}
	if err = worker.Call(ctx, "read.close", workspace.ID, 1, map[string]any{"handle": "test"}, nil); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			var result files.Entry
			if err := worker.Call(ctx, "file.stat", workspace.ID, 1, map[string]any{"path": "main.go"}, &result); err != nil || result.Name != "main.go" {
				t.Errorf("concurrent response: %+v %v", result, err)
			}
		}()
	}
	wait.Wait()
	pool.Close()
	if worker.alive() {
		t.Fatal("worker remained active after pool closure")
	}
	after, err := tmux("display-message", "-p", "-t", "main", "#{pane_pid}")
	if err != nil || string(pid) != string(after) {
		t.Fatalf("terminal process changed: %q %q %v", pid, after, err)
	}
	if _, err = pool.forTerminal(ctx, terminalID); !errorsIsCanceled(err) {
		t.Fatalf("closed pool started worker: %v", err)
	}
}

func errorsIsCanceled(err error) bool {
	return err != nil && strings.Contains(err.Error(), context.Canceled.Error())
}

func TestFileWorkerForeignAccount(t *testing.T) {
	owner := os.Getenv("WORKDECK_FOREIGN_TEST_USER")
	if owner == "" || os.Geteuid() != 0 {
		t.Skip("requires a disposable root container and a configured ordinary account")
	}
	account, err := user.Lookup(owner)
	if err != nil {
		t.Fatal(err)
	}
	a, terminalID := testAgent(t, owner)
	pool := newFileWorkerPool(a)
	defer pool.Close()
	root := filepath.Join(account.HomeDir, "worker-test-project")
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	uid, gid := 0, 0
	fmt.Sscan(account.Uid, &uid)
	fmt.Sscan(account.Gid, &gid)
	if err = os.Chown(root, uid, gid); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "root-only"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	defer os.RemoveAll(filepath.Join(account.HomeDir, ".local", "share", "workdeck", "file-worker", a.identity.NodeID))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	worker, err := pool.forTerminal(ctx, terminalID)
	if err != nil {
		t.Fatal(err)
	}
	workspace := files.Workspace{ID: files.NewID(time.Now()), TerminalID: terminalID, Root: root, Revision: 1}
	var registered files.Workspace
	if err = worker.Call(ctx, "workspace.register", "", 0, workspace, &registered); err != nil {
		t.Fatal(err)
	}
	if registered.User != owner {
		t.Fatalf("wrong execution account: %q", registered.User)
	}
	var entry files.Entry
	err = worker.Call(ctx, "file.stat", workspace.ID, 1, map[string]any{"path": "root-only"}, &entry)
	if files.ErrorCode(err) != "FILE_UNAVAILABLE" {
		t.Fatalf("foreign worker read root-only file: %v", err)
	}
	out, err := json.Marshal(registered)
	if err != nil || len(out) == 0 {
		t.Fatal(err)
	}
}

func TestWorkerCancellationBarrierPreventsDelayedCommit(t *testing.T) {
	account, err := serviceUser()
	if err != nil {
		t.Fatal(err)
	}
	a, terminal := testAgent(t, account.Username)
	pool := newFileWorkerPool(a)
	pool.selfBinary = testWorkerBinary(t)
	pool.statePath = func(_ *user.User, _ string) string { return filepath.Join(t.TempDir(), "state") }
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	worker, err := pool.forTerminal(ctx, terminal)
	if err != nil {
		t.Fatal(err)
	}
	root, next := t.TempDir(), t.TempDir()
	if err = os.WriteFile(filepath.Join(root, "file"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	spec := files.Workspace{ID: files.NewID(time.Now()), TerminalID: terminal, Root: root, Revision: 1}
	var registered files.Workspace
	if err = worker.Call(ctx, "workspace.register", "", 0, spec, &registered); err != nil {
		t.Fatal(err)
	}
	if err = worker.Call(ctx, "read.open", spec.ID, 1, map[string]any{"handle": "held", "path": "file", "version": ""}, nil); err != nil {
		t.Fatal(err)
	}
	op := files.NewID(time.Now())
	var prepared files.RootChange
	if err = worker.Call(ctx, "workspace.prepare", spec.ID, 1, map[string]any{"op_id": op, "root_path": next}, &prepared); err != nil {
		t.Fatal(err)
	}
	short, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	err = worker.Call(short, "workspace.commit", spec.ID, 1, map[string]any{"op_id": op}, nil)
	stop()
	if err == nil {
		t.Fatal("blocked commit ignored cancellation")
	}
	if err = worker.Call(ctx, "read.close", spec.ID, 1, map[string]any{"handle": "held"}, nil); err != nil {
		t.Fatal(err)
	}
	var result files.RootChange
	if err = worker.Call(ctx, "workspace.status", spec.ID, 1, map[string]any{"op_id": op}, &result); err != nil || result.State != "prepared" {
		t.Fatal("canceled commit ran after read closed", result, err)
	}
	var identity files.Workspace
	if err = worker.Call(ctx, "workspace.identity", spec.ID, 0, map[string]any{"terminal_id": terminal}, &identity); err != nil || identity.Revision != 1 {
		t.Fatal(identity, err)
	}
}
