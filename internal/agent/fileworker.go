package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"workdeck/internal/files"
)

// A pool belongs to one authenticated Agent control connection. It never
// starts or stops the separate tmux/systemd session units.
type fileWorkerPool struct {
	agent   *Agent
	mu      sync.Mutex
	workers map[string]*fileWorkerClient
	closed  bool
	// Overrides are used only by isolated package tests.
	selfBinary    string
	foreignBinary string
	statePath     func(*user.User, string) string
}

func newFileWorkerPool(agent *Agent) *fileWorkerPool {
	return &fileWorkerPool{agent: agent, workers: make(map[string]*fileWorkerClient), foreignBinary: "/usr/local/libexec/workdeck-file-worker"}
}

func (p *fileWorkerPool) forTerminal(ctx context.Context, terminalID string) (*fileWorkerClient, error) {
	if !validID(terminalID) || !validID(p.agent.identity.NodeID) {
		return nil, errors.New("invalid node or terminal ID")
	}
	p.agent.sessions.mu.Lock()
	session, err := p.agent.sessions.read(terminalID)
	p.agent.sessions.mu.Unlock()
	if err != nil || session.ID != terminalID {
		return nil, errors.New("terminal record unavailable")
	}
	current, err := serviceUser()
	if err != nil {
		return nil, err
	}
	owner := session.RunUser
	if owner == "" {
		owner = current.Username
	}
	account, err := user.Lookup(owner)
	if err != nil || !filepath.IsAbs(account.HomeDir) {
		return nil, errors.New("terminal account unavailable")
	}
	if account.Uid != current.Uid && os.Geteuid() != 0 {
		return nil, errors.New("terminal belongs to another system account")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, context.Canceled
	}
	accountKey := account.Uid + "\x00" + account.HomeDir + "\x00" + account.Username
	if worker := p.workers[accountKey]; worker != nil && worker.alive() {
		return worker, nil
	}
	binary := p.selfBinary
	if binary == "" {
		binary, err = os.Executable()
		if err != nil {
			return nil, err
		}
	}
	if account.Uid != current.Uid {
		binary = p.foreignBinary
	}
	if !filepath.IsAbs(binary) {
		return nil, errors.New("file worker executable must be absolute")
	}
	if account.Uid != current.Uid {
		if err := trustedWorkerPath(binary); err != nil {
			return nil, err
		}
	}
	workerEnv := []string{"HOME=" + account.HomeDir, "USER=" + account.Username, "LOGNAME=" + account.Username, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	verifyCtx, cancelVerify := context.WithTimeout(ctx, 5*time.Second)
	defer cancelVerify()
	verify, err := sessionCommand(verifyCtx, session, binary, "version")
	if err != nil {
		return nil, err
	}
	verify.Env = workerEnv
	version, err := verify.Output()
	if err != nil || strings.TrimSpace(string(version)) != p.agent.version {
		return nil, errors.New("file worker version unavailable or mismatched")
	}
	stateDir := filepath.Join(account.HomeDir, ".local", "share", "workdeck", "file-worker", p.agent.identity.NodeID)
	if p.statePath != nil {
		stateDir = p.statePath(account, p.agent.identity.NodeID)
	}
	if !filepath.IsAbs(stateDir) {
		return nil, errors.New("file worker state path must be absolute")
	}
	// The manager explicitly terminates this process group on disconnect. Using
	// the connection context in exec.CommandContext would kill only runuser and
	// could leave its child alive with a stale authorization lease.
	cmd, err := sessionCommand(context.Background(), session, binary, "file-worker", "--data-dir", stateDir)
	if err != nil {
		return nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = workerEnv
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, err
	}
	worker := newFileWorkerClient(cmd, stdin, stdout)
	p.workers[accountKey] = worker
	return worker, nil
}

// A root Agent must not execute a foreign-account worker from a path that an
// unprivileged user can replace. Check the executable and every parent.
func trustedWorkerPath(name string) error {
	for current := name; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
			return errors.New("file worker path must be root-owned and not writable by other accounts")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 {
			return errors.New("file worker path must be root-owned")
		}
		if current == name && !info.Mode().IsRegular() {
			return errors.New("file worker executable is not a regular file")
		}
		if current != name && !info.IsDir() {
			return errors.New("invalid file worker parent directory")
		}
		if current == "/" {
			break
		}
	}
	return nil
}

func (p *fileWorkerPool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	workers := p.workers
	p.workers = make(map[string]*fileWorkerClient)
	p.mu.Unlock()
	var wait sync.WaitGroup
	for _, worker := range workers {
		wait.Add(1)
		go func(w *fileWorkerClient) { defer wait.Done(); w.Close() }(worker)
	}
	wait.Wait()
}

type workerResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *files.Error    `json:"error"`
}
type workerWrite struct {
	ctx  context.Context
	data []byte
	done chan error
}

type fileWorkerClient struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	mu       sync.Mutex
	pending  map[string]chan workerResponse
	closed   bool
	writes   chan workerWrite
	stopping chan struct{}
	done     chan struct{}
	once     sync.Once
}

func newFileWorkerClient(cmd *exec.Cmd, stdin io.WriteCloser, stdout io.ReadCloser) *fileWorkerClient {
	w := &fileWorkerClient{cmd: cmd, stdin: stdin, pending: make(map[string]chan workerResponse), writes: make(chan workerWrite, 32), stopping: make(chan struct{}), done: make(chan struct{})}
	go w.writeLoop()
	go w.readLoop(stdout)
	go func() { _ = cmd.Wait(); w.failPending(); close(w.done) }()
	return w
}

func (w *fileWorkerClient) alive() bool {
	select {
	case <-w.done:
		return false
	case <-w.stopping:
		return false
	default:
		return true
	}
}

func (w *fileWorkerClient) writeLoop() {
	for {
		select {
		case <-w.stopping:
			return
		case <-w.done:
			return
		case request := <-w.writes:
			if err := request.ctx.Err(); err != nil {
				request.done <- err
				continue
			}
			n, err := w.stdin.Write(request.data)
			if err == nil && n != len(request.data) {
				err = io.ErrShortWrite
			}
			request.done <- err
			if err != nil {
				go w.Close()
				return
			}
		}
	}
}

func (w *fileWorkerClient) readLoop(stdout io.ReadCloser) {
	defer stdout.Close()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		var response workerResponse
		if json.Unmarshal(scanner.Bytes(), &response) != nil || response.ID == "" {
			go w.Close()
			return
		}
		w.mu.Lock()
		channel := w.pending[response.ID]
		delete(w.pending, response.ID)
		w.mu.Unlock()
		if channel != nil {
			channel <- response
		}
	}
	if w.alive() {
		go w.Close()
	}
}

func (w *fileWorkerClient) failPending() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	for id, ch := range w.pending {
		ch <- workerResponse{ID: id, Error: &files.Error{Code: "WORKER_DISCONNECTED", Message: "节点文件服务已断开"}}
		delete(w.pending, id)
	}
}

func (w *fileWorkerClient) Call(ctx context.Context, method, workspace string, revision int64, params any, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	id := files.NewID(time.Now())
	data, err := json.Marshal(struct {
		ID        string `json:"id"`
		Method    string `json:"method"`
		Workspace string `json:"workspace_id,omitempty"`
		Revision  int64  `json:"root_revision,omitempty"`
		Params    any    `json:"params,omitempty"`
	}{id, method, workspace, revision, params})
	if err != nil {
		return err
	}
	if len(data) >= 64<<10-1 {
		return errors.New("file worker request exceeds limit")
	}
	data = append(data, '\n')
	response := make(chan workerResponse, 1)
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return errors.New("file worker disconnected")
	}
	w.pending[id] = response
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, id); w.mu.Unlock() }()
	written := make(chan error, 1)
	enqueued := false
	defer func() {
		if enqueued && ctx.Err() != nil {
			w.cancelRequest(id)
		}
	}()
	select {
	case w.writes <- workerWrite{ctx: ctx, data: data, done: written}:
		enqueued = true
	case <-ctx.Done():
		return ctx.Err()
	case <-w.stopping:
		return context.Canceled
	case <-w.done:
		return errors.New("file worker disconnected")
	}
	select {
	case err = <-written:
		if err != nil {
			return err
		}
	case <-ctx.Done():
		return ctx.Err()
	case <-w.stopping:
		return context.Canceled
	case <-w.done:
		return errors.New("file worker disconnected")
	}
	select {
	case reply := <-response:
		if reply.Error != nil {
			return reply.Error
		}
		if result != nil && len(reply.Result) > 0 && string(reply.Result) != "null" {
			if err = json.Unmarshal(reply.Result, result); err != nil {
				return fmt.Errorf("invalid file worker response: %w", err)
			}
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-w.stopping:
		return context.Canceled
	case <-w.done:
		return errors.New("file worker disconnected")
	}
}

// Cancel queued or running worker requests when an authorization lease ends.
// If the pipe is blocked, stop the worker process group so stale work cannot
// remain authorized indefinitely; this never affects terminal processes.
func (w *fileWorkerClient) cancelRequest(target string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cancelID := files.NewID(time.Now())
	data, err := json.Marshal(map[string]any{"id": cancelID, "method": "request.cancel", "params": map[string]string{"target": target}})
	if err != nil {
		return
	}
	response := make(chan workerResponse, 1)
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.pending[cancelID] = response
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, cancelID); w.mu.Unlock() }()
	written := make(chan error, 1)
	select {
	case w.writes <- workerWrite{ctx: ctx, data: append(data, '\n'), done: written}:
	case <-w.stopping:
		return
	case <-w.done:
		return
	case <-ctx.Done():
		go w.Close()
		return
	}
	select {
	case err = <-written:
		if err != nil {
			go w.Close()
			return
		}
	case <-w.stopping:
		return
	case <-w.done:
		return
	case <-ctx.Done():
		go w.Close()
		return
	}
	select {
	case <-response:
	case <-w.stopping:
	case <-w.done:
	case <-ctx.Done():
		go w.Close()
	}
}

func (w *fileWorkerClient) Close() {
	w.once.Do(func() {
		close(w.stopping)
		_ = w.stdin.Close()
		if w.cmd.Process != nil {
			_ = syscall.Kill(-w.cmd.Process.Pid, syscall.SIGTERM)
		}
		select {
		case <-w.done:
		case <-time.After(2 * time.Second):
			if w.cmd.Process != nil {
				_ = syscall.Kill(-w.cmd.Process.Pid, syscall.SIGKILL)
			}
			select {
			case <-w.done:
			case <-time.After(2 * time.Second):
			}
		}
		w.failPending()
	})
}
