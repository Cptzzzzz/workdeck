package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

type managedLaunch struct {
	Options protocol.CodexLaunchOptions `json:"options"`
	Cwd     string                      `json:"cwd"`
	Shell   string                      `json:"shell"`
	Thread  string                      `json:"thread,omitempty"`
}

func randomEventID() string { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }

func managedPath(dir, id string) string { return filepath.Join(dir, "codex-launches", id+".json") }

func codexBinary() (string, error) {
	p, e := exec.LookPath("codex")
	if e != nil {
		return "", errors.New("节点未安装 Codex，或服务 PATH 中找不到 codex")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, e := exec.CommandContext(ctx, p, "--help").Output()
	if e != nil || !strings.Contains(string(out), "--remote") {
		return "", errors.New("节点 Codex 版本不支持受管会话，请升级至支持 --remote 和 Unix app-server 的版本")
	}
	return p, nil
}

func proxyEnvironment(base []string, o protocol.CodexLaunchOptions) []string {
	if o.ProxyMode == "inherit" {
		return append([]string(nil), base...)
	}
	result := []string{}
	for _, v := range base {
		key, _, _ := strings.Cut(v, "=")
		switch strings.ToUpper(key) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY":
		default:
			result = append(result, v)
		}
	}
	if o.ProxyMode == "custom" {
		for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
			result = append(result, k+"="+o.Proxy)
		}
	}
	return result
}

var errCodexNotMaterialized = errors.New("Codex 会话尚未开始第一轮")

type codexRPC struct {
	ws   *websocket.Conn
	next int
}

func connectCodex(path string) (*codexRPC, error) {
	d := websocket.Dialer{HandshakeTimeout: 3 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	w, _, e := d.Dial("ws://localhost/", nil)
	if e != nil {
		return nil, e
	}
	r := &codexRPC{ws: w}
	var initialized json.RawMessage
	e = r.call("initialize", map[string]any{"clientInfo": map[string]string{"name": "workdeck_observer", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &initialized)
	if e == nil {
		e = w.WriteJSON(map[string]any{"method": "initialized"})
	}
	if e != nil {
		w.Close()
		return nil, e
	}
	return r, nil
}
func (r *codexRPC) call(method string, params, result any) error {
	r.next++
	id := r.next
	r.ws.SetWriteDeadline(time.Now().Add(3 * time.Second))
	r.ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	r.ws.SetReadLimit(4 << 20)
	if e := r.ws.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); e != nil {
		return e
	}
	for {
		var v struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if e := r.ws.ReadJSON(&v); e != nil {
			return e
		}
		if v.ID != id {
			continue
		}
		if len(v.Error) > 0 {
			if strings.Contains(string(v.Error), "not materialized yet") {
				return errCodexNotMaterialized
			}
			return fmt.Errorf("Codex 接口 %s 不可用", method)
		}
		return json.Unmarshal(v.Result, result)
	}
}

// ManagedCodex runs inside the terminal's independent systemd unit. Agent/Hub
// reconnects and browser disconnects do not own or terminate these processes.
func ManagedCodex(dir, id string) (result error) {
	if !filepath.IsAbs(dir) || !validID(id) {
		return errors.New("invalid managed session")
	}
	b, e := os.ReadFile(managedPath(dir, id))
	if e != nil {
		return e
	}
	var launch managedLaunch
	if json.Unmarshal(b, &launch) != nil {
		return errors.New("受管会话配置损坏")
	}
	if e = launch.Options.Validate(); e != nil {
		return e
	}
	defer func() {
		if result != nil {
			fmt.Fprintln(os.Stderr, "受管 Codex 启动失败：", result)
			writeManagedObservation(dir, id, protocol.CodexObservation{Managed: true, ThreadID: launch.Thread, Status: "unknown"})
		}
		shell := exec.Command(launch.Shell, "-l")
		shell.Dir = launch.Cwd
		shell.Env = os.Environ()
		shell.Stdin = os.Stdin
		shell.Stdout = os.Stdout
		shell.Stderr = os.Stderr
		result = shell.Run()
	}()
	bin, e := codexBinary()
	if e != nil {
		return e
	}
	runtime, e := os.MkdirTemp("", "workdeck-codex-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(runtime)
	path := filepath.Join(runtime, "rpc.sock")
	log, e := os.OpenFile(filepath.Join(runtime, "backend.log"), os.O_CREATE|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer log.Close()
	backend := exec.Command(bin, "app-server", "--listen", "unix://"+path)
	backend.Dir = launch.Cwd
	backend.Env = append(proxyEnvironment(os.Environ(), launch.Options), "WORKDECK_MANAGED_CODEX=1")
	backend.Stdout = log
	backend.Stderr = log
	if e = backend.Start(); e != nil {
		return errors.New("Codex 后端启动失败")
	}
	done := make(chan error, 1)
	go func() { done <- backend.Wait() }()
	defer func() {
		_ = backend.Process.Kill()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}()
	var seed *codexRPC
	for n := 0; n < 100; n++ {
		select {
		case <-done:
			return errors.New("Codex 后端提前退出，请检查节点 Codex 配置")
		default:
		}
		seed, e = connectCodex(path)
		if e == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if e != nil {
		return errors.New("Codex 本地接口启动超时")
	}
	if launch.Options.Resume != "" {
		// The remote TUI rejects permission flags on `resume`. Apply the
		// explicitly requested options through the backend before attaching it.
		params := map[string]any{"threadId": launch.Options.Resume, "cwd": launch.Cwd, "approvalPolicy": launch.Options.Approval, "sandbox": launch.Options.Sandbox, "excludeTurns": true}
		if launch.Options.Model != "" {
			params["model"] = launch.Options.Model
		}
		if launch.Options.Effort != "" {
			params["config"] = map[string]string{"model_reasoning_effort": launch.Options.Effort}
		}
		var resumed json.RawMessage
		e = seed.call("thread/resume", params, &resumed)
		if e != nil {
			seed.ws.Close()
			return e
		}
	}
	seed.ws.Close()
	launch.Thread = launch.Options.Resume
	ctx, cancel := context.WithCancel(context.Background())
	observed := make(chan struct{})
	go func() { defer close(observed); observeManagedCodex(ctx, dir, id, path, launch) }()
	// Let the TUI create new threads: an empty thread cannot yet be resumed
	// because Codex has not materialized its rollout before the first input.
	// Remote mode does not use the TUI process cwd as an explicit workspace.
	// --cd also scopes /resume and overrides a resumed thread's saved cwd.
	args := []string{"--remote", "unix://" + path, "--cd", launch.Cwd}
	if launch.Options.Resume != "" {
		args = append(args, "resume", launch.Options.Resume)
	} else {
		args = append(args, "--ask-for-approval", launch.Options.Approval, "--sandbox", launch.Options.Sandbox)
		if launch.Options.Model != "" {
			args = append(args, "--model", launch.Options.Model)
		}
		if launch.Options.Effort != "" {
			args = append(args, "-c", "model_reasoning_effort="+launch.Options.Effort)
		}
	}
	tui := exec.Command(bin, args...)
	tui.Dir = launch.Cwd
	tui.Env = backend.Env
	tui.Stdin = os.Stdin
	tui.Stdout = os.Stdout
	tui.Stderr = os.Stderr
	e = tui.Run()
	cancel()
	<-observed
	// Exit Codex to a usable shell rather than destroying the persistent tmux
	// terminal. All descendants stay under the terminal's existing unit.
	_ = backend.Process.Kill()
	if b, err := os.ReadFile(managedPath(dir, id)); err == nil {
		_ = json.Unmarshal(b, &launch)
	}
	writeManagedObservation(dir, id, protocol.CodexObservation{Managed: true, ThreadID: launch.Thread, Status: "session_ended"})
	if e != nil {
		fmt.Fprintln(os.Stderr, "Codex 已退出；可检查版本、登录状态和节点配置后重新创建受管会话。")
	}
	return nil
}

func writeManagedObservation(dir, id string, o protocol.CodexObservation) {
	o.EventID = randomEventID()
	o.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	detected := o.Status != "session_ended" && o.Status != "unknown"
	o.Detected = &detected
	_ = os.MkdirAll(filepath.Join(dir, "codex-events"), 0700)
	_ = atomicJSON(codexEventPath(dir, id), o)
}

func observeManagedCodex(ctx context.Context, dir, id, path string, launch managedLaunch) {
	thread := launch.Thread
	var previous string
	var rpc *codexRPC
	defer func() {
		if rpc != nil {
			rpc.ws.Close()
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if rpc == nil {
			var e error
			rpc, e = connectCodex(path)
			if e != nil {
				continue
			}
		}
		if thread == "" {
			var loaded struct {
				Data []string `json:"data"`
			}
			if e := rpc.call("thread/loaded/list", map[string]any{}, &loaded); e != nil {
				rpc.ws.Close()
				rpc = nil
				continue
			}
			for _, candidate := range loaded.Data {
				var read struct {
					Thread struct {
						Parent *string `json:"parentThreadId"`
						Cwd    string  `json:"cwd"`
					} `json:"thread"`
				}
				if rpc.call("thread/read", map[string]any{"threadId": candidate}, &read) == nil && read.Thread.Parent == nil && read.Thread.Cwd == launch.Cwd {
					thread = candidate
					launch.Thread = thread
					_ = atomicJSON(managedPath(dir, id), launch)
					break
				}
			}
			if thread == "" {
				continue
			}
		}
		o, e := sampleManagedCodex(rpc, thread)
		if e != nil {
			rpc.ws.Close()
			rpc = nil
			o = protocol.CodexObservation{Managed: true, ThreadID: thread, Status: "unknown"}
		}
		b, _ := json.Marshal(o)
		if string(b) == previous {
			continue
		}
		previous = string(b)
		if ctx.Err() != nil {
			return
		}
		writeManagedObservation(dir, id, o)
	}
}

func sampleManagedCodex(r *codexRPC, thread string) (protocol.CodexObservation, error) {
	o := protocol.CodexObservation{Managed: true, ThreadID: thread, Status: "ready"}
	var read struct {
		Thread struct {
			Status struct {
				Type        string   `json:"type"`
				ActiveFlags []string `json:"activeFlags"`
			} `json:"status"`
		} `json:"thread"`
	}
	if e := r.call("thread/read", map[string]any{"threadId": thread}, &read); e != nil {
		return o, e
	}
	var goal struct {
		Goal *struct {
			Status          string `json:"status"`
			TokensUsed      int64  `json:"tokensUsed"`
			TokenBudget     *int64 `json:"tokenBudget"`
			TimeUsedSeconds int64  `json:"timeUsedSeconds"`
			CreatedAt       int64  `json:"createdAt"`
		} `json:"goal"`
	}
	if e := r.call("thread/goal/get", map[string]any{"threadId": thread}, &goal); e != nil {
		return o, e
	}
	if g := goal.Goal; g != nil {
		o.Goal = &protocol.CodexGoal{Status: g.Status, TokensUsed: g.TokensUsed, TokenBudget: g.TokenBudget, TimeUsedSeconds: g.TimeUsedSeconds, CreatedAt: g.CreatedAt}
	}
	var turns struct {
		Data []struct {
			ID          string `json:"id"`
			Status      string `json:"status"`
			CompletedAt *int64 `json:"completedAt"`
		} `json:"data"`
	}
	if e := r.call("thread/turns/list", map[string]any{"threadId": thread, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, &turns); e != nil && !errors.Is(e, errCodexNotMaterialized) {
		return o, e
	}
	if len(turns.Data) > 0 {
		t := turns.Data[0]
		o.TurnID = t.ID
		if t.CompletedAt != nil {
			o.CompletedAt = time.Unix(*t.CompletedAt, 0).UTC().Format(time.RFC3339Nano)
		}
		switch t.Status {
		case "completed":
			o.Status = "turn_ended"
		case "interrupted":
			o.Status = "interrupted"
		case "inProgress":
			o.Status = "running"
		}
	}
	if o.Goal != nil {
		switch o.Goal.Status {
		case "active":
			o.Status = "goal_active"
		case "complete":
			o.Status = "goal_complete"
		case "paused":
			o.Status = "goal_paused"
		case "blocked":
			o.Status = "goal_blocked"
		case "budgetLimited":
			o.Status = "goal_budget_limited"
		case "usageLimited":
			o.Status = "goal_usage_limited"
		default:
			o.Status = "unknown"
		}
	}
	if read.Thread.Status.Type == "active" {
		o.Status = "running"
		if o.Goal != nil && o.Goal.Status == "active" {
			o.Status = "goal_active"
		}
		for _, f := range read.Thread.Status.ActiveFlags {
			if f == "waitingOnApproval" || f == "waitingOnUserInput" {
				o.Status = "attention"
			}
		}
	}
	if read.Thread.Status.Type == "systemError" || read.Thread.Status.Type == "notLoaded" {
		o.Status = "unknown"
	}
	return o, nil
}
