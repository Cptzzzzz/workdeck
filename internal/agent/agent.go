package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"workdeck/internal/protocol"
)

type Agent struct {
	identity Identity
	key      ed25519.PrivateKey
	sessions *Sessions
	version  string
	stateMu  sync.Mutex
}

func New(dir, version string) (*Agent, error) {
	identity, key, err := loadIdentity(dir)
	if err != nil {
		return nil, err
	}
	sessions, err := newSessions(dir)
	if err != nil {
		return nil, err
	}
	return &Agent{identity: identity, key: key, sessions: sessions, version: version}, nil
}
func (a *Agent) dial(path, ticket string) (*protocol.Socket, error) {
	url := "ws" + strings.TrimPrefix(a.identity.Hub, "http") + path
	headers := signedHeaders(a.identity, a.key, path)
	if ticket != "" {
		headers.Set("X-Workdeck-Ticket", ticket)
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: nil}
	conn, res, err := dialer.Dial(url, headers)
	if err != nil {
		if res != nil {
			return nil, fmt.Errorf("connect: HTTP %d", res.StatusCode)
		}
		return nil, err
	}
	socket := &protocol.Socket{Conn: conn}
	socket.SetReadLiveness(1 << 20)
	return socket, nil
}
func (a *Agent) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		started := time.Now()
		err := a.connected(ctx)
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("Hub disconnected: %v; retrying in %s", err, backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		} else {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}
func (a *Agent) inventory(socket *protocol.Socket) error {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	return a.sendInventory(socket)
}
func (a *Agent) sendInventory(socket *protocol.Socket) error {
	host, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	sessions, snapshotErr := a.sessions.Inventory()
	if snapshotErr != nil {
		log.Printf("incomplete session inventory: %v", snapshotErr)
	}
	account, err := serviceUser()
	if err != nil {
		return err
	}
	return socket.JSON(protocol.Message{Type: "inventory", RunUser: account.Username, Hostname: host, Platform: runtime.GOOS + "/" + runtime.GOARCH, Home: home, Shell: a.sessions.shell, Version: a.version, Sessions: sessions, Complete: snapshotErr == nil, BootID: a.sessions.bootID, Capabilities: []string{"directories", "full-inventory"}})
}
func (a *Agent) connected(parent context.Context) error {
	socket, err := a.dial("/api/agent/control", "")
	if err != nil {
		return err
	}
	defer socket.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go func() { <-ctx.Done(); socket.Close() }()
	go socket.Heartbeat(ctx.Done())
	log.Printf("connected to %s as %s", a.identity.Hub, a.identity.Name)
	if err = a.inventory(socket); err != nil {
		return err
	}
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := a.inventory(socket); err != nil {
					socket.Close()
					return
				}
			}
		}
	}()
	var jobs sync.WaitGroup
	defer func() { cancel(); jobs.Wait() }()
	for {
		var msg protocol.Message
		if err = socket.Conn.ReadJSON(&msg); err != nil {
			return err
		}
		switch msg.Type {
		case "attach":
			jobs.Add(1)
			go func() {
				defer jobs.Done()
				if e := a.attach(ctx, msg); e != nil && ctx.Err() == nil {
					log.Printf("terminal attachment %s: %v", msg.TerminalID, e)
				}
			}()
		case "directories":
			jobs.Add(1)
			go func() {
				defer jobs.Done()
				ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				listing, e := ListDirectories(ctx, msg.Path, msg.IncludeHidden)
				result := protocol.Message{Type: "result", RequestID: msg.RequestID, Directory: listing}
				if e != nil {
					result.Error = e.Error()
				}
				_ = socket.JSON(result)
			}()
		case "create", "close":
			jobs.Add(1)
			go func() {
				defer jobs.Done()
				a.stateMu.Lock()
				defer a.stateMu.Unlock()
				result := protocol.Message{Type: "result", RequestID: msg.RequestID, TerminalID: msg.TerminalID}
				var t protocol.Session
				var e error
				if msg.Type == "create" {
					if msg.Session == nil || msg.Session.ID != msg.TerminalID {
						e = errors.New("invalid session specification")
					} else {
						t, e = a.sessions.Create(*msg.Session)
					}
				} else {
					t, e = a.sessions.Close(msg.TerminalID)
				}
				if e != nil {
					result.Error = e.Error()
					if t.State == "" || t.State == "creating" {
						t.State = "error"
						t.Error = e.Error()
					}
				}
				result.Session = &t
				_ = socket.JSON(result)
				_ = a.sendInventory(socket)
			}()
		}
	}
}
func (a *Agent) attach(parent context.Context, msg protocol.Message) error {
	socket, err := a.dial("/api/agent/data", msg.Ticket)
	if err != nil {
		return err
	}
	defer socket.Close()
	cmd, err := a.sessions.AttachCommand(msg.TerminalID, msg.ReadOnly)
	if err != nil {
		_ = socket.JSON(protocol.Frame{Type: "error", Message: err.Error()})
		return err
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 30})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer func() { _ = f.Close(); _ = cmd.Process.Signal(syscall.SIGHUP); _ = cmd.Wait() }()
	go func() { <-ctx.Done(); socket.Close(); _ = f.Close() }()
	go socket.Heartbeat(ctx.Done())
	ack := make(chan int, 128)
	errorsCh := make(chan error, 2)
	go func() {
		for {
			kind, b, e := socket.Conn.ReadMessage()
			if e != nil {
				errorsCh <- e
				return
			}
			if kind == websocket.BinaryMessage {
				if msg.ReadOnly {
					continue
				}
				_, e = f.Write(b)
			} else if kind == websocket.TextMessage {
				var frame protocol.Frame
				if json.Unmarshal(b, &frame) != nil {
					continue
				}
				switch frame.Type {
				case "resize":
					{
						cols, rows := frame.Cols, frame.Rows
						if cols < 10 {
							cols = 10
						}
						if cols > 500 {
							cols = 500
						}
						if rows < 3 {
							rows = 3
						}
						if rows > 250 {
							rows = 250
						}
						e = pty.Setsize(f, &pty.Winsize{Cols: cols, Rows: rows})
						if e == nil && !msg.ReadOnly {
							// Set the pane's canonical size explicitly: old tmux versions do not
							// support latest/ignore-size, and viewers must never resize a TUI.
							_, e = a.sessions.tmuxRun(msg.TerminalID, "resize-window", "-t", "main", "-x", strconv.Itoa(int(cols)), "-y", strconv.Itoa(int(rows)))
						}
					}
				case "ack":
					if frame.Bytes > 0 && frame.Bytes <= 32768 {
						select {
						case ack <- frame.Bytes:
						case <-ctx.Done():
							return
						}
					}
				}
			}
			if e != nil {
				errorsCh <- e
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 16384)
		outstanding := 0
		for {
			for {
				select {
				case n := <-ack:
					outstanding -= n
					if outstanding < 0 {
						outstanding = 0
					}
				default:
					goto drained
				}
			}
		drained:
			for outstanding >= 256*1024 {
				select {
				case n := <-ack:
					outstanding -= n
				case <-ctx.Done():
					return
				case <-time.After(12 * time.Second):
					errorsCh <- errors.New("browser too slow; reconnect to redraw")
					return
				}
			}
			n, e := f.Read(buf)
			if n > 0 {
				if e2 := socket.Write(websocket.BinaryMessage, buf[:n]); e2 != nil {
					errorsCh <- e2
					return
				}
				outstanding += n
			}
			if e != nil {
				errorsCh <- e
				return
			}
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err = <-errorsCh:
		return err
	}
}
