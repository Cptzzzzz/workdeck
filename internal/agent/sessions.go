package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"workdeck/internal/protocol"
)

type Sessions struct {
	dir, shell, tmux string
	bootID           string
	mu               sync.Mutex
}

const scrollingConfig = `set -g mouse on
bind-key -T copy-mode Up send-keys -X cancel \; send-keys Up
bind-key -T copy-mode Down send-keys -X cancel \; send-keys Down
bind-key -T copy-mode-vi Up send-keys -X cancel \; send-keys Up
bind-key -T copy-mode-vi Down send-keys -X cancel \; send-keys Down
bind-key -T copy-mode-vi Escape send-keys -X cancel
`

func newSessions(dir string) (*Sessions, error) {
	t, err := exec.LookPath("tmux")
	if err != nil {
		return nil, errors.New("tmux is required")
	}
	if _, err = exec.LookPath("systemd-run"); err != nil {
		return nil, errors.New("systemd-run and a running systemd service manager are required")
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	if !filepath.IsAbs(shell) {
		return nil, errors.New("SHELL must be an absolute path")
	}
	if err = os.MkdirAll(filepath.Join(dir, "sessions"), 0700); err != nil {
		return nil, err
	}
	config := `set -g status off
set -g exit-unattached off
set -g destroy-unattached off
set -g default-terminal tmux-256color
set -as terminal-overrides ',xterm-256color:Tc'
set -g history-limit 10000
set -g remain-on-exit on
set -g escape-time 10
set -g set-clipboard off
set -g allow-rename off
set -g window-size manual
` + scrollingConfig
	if err = os.WriteFile(filepath.Join(dir, "tmux.conf"), []byte(config), 0600); err != nil {
		return nil, err
	}
	bootID, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return &Sessions{dir: dir, shell: shell, tmux: t, bootID: strings.TrimSpace(string(bootID))}, nil
}
func validID(id string) bool {
	if len(id) != 48 {
		return false
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func socketName(id string) string         { return "workdeck-" + id }
func unitName(id string) string           { return "workdeck-session-" + id }
func (s *Sessions) path(id string) string { return filepath.Join(s.dir, "sessions", id+".json") }
func (s *Sessions) tmuxRun(id string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args = append([]string{"-L", socketName(id)}, args...)
	record, _ := s.read(id)
	command, err := sessionCommand(ctx, record, s.tmux, args...)
	if err != nil {
		return nil, err
	}
	return command.CombinedOutput()
}
func (s *Sessions) read(id string) (protocol.Session, error) {
	var t protocol.Session
	b, e := os.ReadFile(s.path(id))
	if e != nil {
		return t, e
	}
	e = json.Unmarshal(b, &t)
	return t, e
}
func (s *Sessions) inspect(t protocol.Session) protocol.Session {
	if t.State == "closed" || t.State == "error" {
		return t
	}
	out, err := s.tmuxRun(t.ID, "display-message", "-p", "-t", "main:0.0", "#{pane_dead}:#{pane_dead_status}")
	if err != nil {
		t.State = "lost"
		t.Error = "会话进程已不存在，节点可能重启过"
		if t.BootID != "" && s.bootID != "" && t.BootID != s.bootID {
			t.Error = "节点已重启，原终端进程已结束；可重新创建终端"
		}
		return t
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), ":", 2)
	if parts[0] == "1" {
		t.State = "exited"
		if len(parts) == 2 {
			if n, e := strconv.Atoi(parts[1]); e == nil {
				t.ExitCode = &n
			}
		}
	} else {
		t.State = "running"
		t.Error = ""
	}
	return t
}
func (s *Sessions) Inventory() ([]protocol.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []protocol.Session{}
	files, err := os.ReadDir(filepath.Join(s.dir, "sessions"))
	if err != nil {
		return list, err
	}
	var snapshotErr error
	for _, entry := range files {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		p := filepath.Join(s.dir, "sessions", entry.Name())
		id := strings.TrimSuffix(filepath.Base(p), ".json")
		if !validID(id) {
			continue
		}
		t, e := s.read(id)
		if e != nil {
			snapshotErr = errors.New("部分会话记录无法读取，已保留主服务中的原状态")
			continue
		}
		if t.ID != id {
			snapshotErr = errors.New("会话记录标识不匹配")
			continue
		}
		previous, _ := json.Marshal(t)
		if t.RunUser == "" {
			if account, e := serviceUser(); e == nil {
				t.RunUser = account.Username
			} else {
				snapshotErr = e
			}
		}
		if t.Scope == "" {
			t.Scope = serviceScope()
		}
		t = s.inspect(t)
		if t.State == "running" && t.BootID == "" {
			t.BootID = s.bootID
		}
		updated, _ := json.Marshal(t)
		if string(previous) != string(updated) {
			if err := atomicJSON(s.path(t.ID), t); err != nil {
				snapshotErr = err
			}
		}
		list = append(list, t)
	}
	return list, snapshotErr
}
func (s *Sessions) Create(spec protocol.Session) (protocol.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validID(spec.ID) {
		return spec, errors.New("invalid terminal ID")
	}
	if t, err := s.read(spec.ID); err == nil {
		return s.inspect(t), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return spec, err
	}
	if !filepath.IsAbs(spec.Cwd) {
		return spec, errors.New("working directory must be absolute")
	}
	info, err := os.Stat(spec.Cwd)
	if err != nil || !info.IsDir() {
		return spec, errors.New("工作目录不存在或无法访问")
	}
	account, err := serviceUser()
	if err != nil {
		return spec, err
	}
	spec.RunUser = account.Username
	spec.Scope = serviceScope()
	spec.State = "creating"
	spec.BootID = s.bootID
	if err = atomicJSON(s.path(spec.ID), spec); err != nil {
		return spec, err
	}
	// Every terminal owns a separate systemd unit, tmux server, and cgroup.
	// Its lifecycle is independent of the network Agent service.
	args := []string{"--unit=" + unitName(spec.ID), "--property=Type=forking", "--property=Restart=no", "--property=KillMode=control-group", "--property=TimeoutStopSec=8", "--setenv=COLORTERM=truecolor", "--setenv=LANG=C.UTF-8", "--setenv=HOME=" + account.HomeDir, "--setenv=USER=" + account.Username, "--setenv=LOGNAME=" + account.Username, s.tmux, "-L", socketName(spec.ID), "-f", filepath.Join(s.dir, "tmux.conf"), "new-session", "-d", "-s", "main", "-x", "100", "-y", "30", "-c", spec.Cwd, s.shell, "-l"}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command, err := managerCommand(ctx, spec, "systemd-run", args...)
	if err != nil {
		return spec, err
	}
	out, err := command.CombinedOutput()
	if err != nil {
		spec.State = "error"
		spec.Error = "启动终端失败：" + strings.TrimSpace(string(out))
		_ = atomicJSON(s.path(spec.ID), spec)
		return spec, errors.New(spec.Error)
	}
	spec = s.inspect(spec)
	if spec.State == "lost" {
		spec.State = "error"
		spec.Error = "终端进程启动后立即退出"
	}
	if err = atomicJSON(s.path(spec.ID), spec); err != nil {
		return spec, err
	}
	return spec, nil
}
func (s *Sessions) Close(id string) (protocol.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validID(id) {
		return protocol.Session{}, errors.New("invalid terminal ID")
	}
	t, err := s.read(id)
	if errors.Is(err, os.ErrNotExist) {
		t = protocol.Session{ID: id, State: "closed"}
		return t, atomicJSON(s.path(id), t)
	}
	if err != nil {
		return t, err
	}
	// Stop the unit, not just the shell: include its background descendants.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command, err := managerCommand(ctx, t, "systemctl", "stop", unitName(id)+".service")
	if err != nil {
		return t, err
	}
	out, stopErr := command.CombinedOutput()
	if stopErr != nil {
		if _, e := s.tmuxRun(id, "has-session", "-t", "main"); e == nil {
			return t, fmt.Errorf("无法终止会话：%s", strings.TrimSpace(string(out)))
		}
	}
	t.State = "closed"
	t.Error = ""
	if err = atomicJSON(s.path(id), t); err != nil {
		return t, err
	}
	return t, nil
}
func (s *Sessions) AttachCommand(id string, readonly bool) (*exec.Cmd, error) {
	if !validID(id) {
		return nil, errors.New("invalid terminal ID")
	}
	s.mu.Lock()
	t, err := s.read(id)
	if err == nil {
		t = s.inspect(t)
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if t.State != "running" && t.State != "exited" {
		return nil, fmt.Errorf("终端无法连接：%s", t.State)
	}
	// Existing servers do not reread tmux.conf after an Agent upgrade. Apply
	// only these idempotent options, as the saved session owner, without ever
	// recreating the pane or requiring a foreign account to read root's files.
	if err := s.configureScrolling(id); err != nil {
		return nil, err
	}
	args := []string{"-L", socketName(id), "attach-session", "-t", "main", "-E"}
	if readonly {
		args = append(args, "-r")
	}
	cmd, err := sessionCommand(context.Background(), t, s.tmux, args...)
	if err != nil {
		return nil, err
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8")
	return cmd, nil
}

func (s *Sessions) configureScrolling(id string) error {
	args := []string{"set-option", "-g", "mouse", "on"}
	for _, table := range []string{"copy-mode", "copy-mode-vi"} {
		for _, key := range []string{"Up", "Down"} {
			args = append(args, ";", "bind-key", "-T", table, key, "send-keys -X cancel ; send-keys "+key)
		}
	}
	args = append(args, ";", "bind-key", "-T", "copy-mode-vi", "Escape", "send-keys -X cancel")
	out, err := s.tmuxRun(id, args...)
	if err != nil {
		return fmt.Errorf("配置终端滚动失败：%s", strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *Sessions) leaveHistory(id string) error {
	_, err := s.tmuxRun(id, "if-shell", "-F", "-t", "main:0.0", "#{pane_in_mode}", "send-keys -X -t main:0.0 cancel")
	return err
}
