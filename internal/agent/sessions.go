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
	mu               sync.Mutex
}

func newSessions(dir string) (*Sessions, error) {
	t, err := exec.LookPath("tmux")
	if err != nil {
		return nil, errors.New("tmux is required")
	}
	if _, err = exec.LookPath("systemd-run"); err != nil {
		return nil, errors.New("systemd-run and a running user systemd manager are required")
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
set -g window-size latest
`
	if err = os.WriteFile(filepath.Join(dir, "tmux.conf"), []byte(config), 0600); err != nil {
		return nil, err
	}
	return &Sessions{dir: dir, shell: shell, tmux: t}, nil
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
	a := append([]string{"-L", socketName(id)}, args...)
	return exec.CommandContext(ctx, s.tmux, a...).CombinedOutput()
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
		if t.State != "exited" {
			t.State = "lost"
			t.Error = "会话进程已不存在，节点可能重启过"
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
func (s *Sessions) Inventory() []protocol.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []protocol.Session{}
	files, _ := filepath.Glob(filepath.Join(s.dir, "sessions", "*.json"))
	for _, p := range files {
		id := strings.TrimSuffix(filepath.Base(p), ".json")
		if !validID(id) {
			continue
		}
		t, e := s.read(id)
		if e == nil {
			t = s.inspect(t)
			list = append(list, t)
		}
	}
	return list
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
	spec.State = "creating"
	if err = atomicJSON(s.path(spec.ID), spec); err != nil {
		return spec, err
	}
	// Every terminal owns a separate systemd unit, tmux server, and cgroup.
	// Its lifecycle is independent of the network Agent service.
	args := []string{"--user", "--unit=" + unitName(spec.ID), "--property=Type=forking", "--property=Restart=no", "--property=KillMode=control-group", "--property=TimeoutStopSec=8", "--setenv=COLORTERM=truecolor", "--setenv=LANG=C.UTF-8", s.tmux, "-L", socketName(spec.ID), "-f", filepath.Join(s.dir, "tmux.conf"), "new-session", "-d", "-s", "main", "-x", "100", "-y", "30", "-c", spec.Cwd, s.shell, "-l"}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemd-run", args...).CombinedOutput()
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
	out, stopErr := exec.CommandContext(ctx, "systemctl", "--user", "stop", unitName(id)+".service").CombinedOutput()
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
	args := []string{"-L", socketName(id), "attach-session", "-t", "main", "-E"}
	if readonly {
		args = append(args, "-r")
	}
	cmd := exec.Command(s.tmux, args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8")
	return cmd, nil
}
