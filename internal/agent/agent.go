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
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
	"workdeck/internal/protocol"
)

type Agent struct {
	identity       Identity
	key            ed25519.PrivateKey
	sessions       *Sessions
	version        string
	stateMu        sync.Mutex
	controlMu      sync.Mutex
	controllers    map[string]string
	fileCommitOnce sync.Once
	fileCommitGate chan struct{}
	fileRateBytes  int
	fileRatesMu    sync.Mutex
	fileRates      map[string]*rate.Limiter
}

func (a *Agent) commitGate() chan struct{} {
	a.fileCommitOnce.Do(func() { a.fileCommitGate = make(chan struct{}, 1) })
	return a.fileCommitGate
}

func New(dir, version string) (*Agent, error) {
	fileRate, err := configuredFileRate(os.Getenv("WORKDECK_FILE_RATE_BYTES_PER_SEC"))
	if err != nil {
		return nil, err
	}
	identity, key, err := loadIdentity(dir)
	if err != nil {
		return nil, err
	}
	sessions, err := newSessions(dir)
	if err != nil {
		return nil, err
	}
	return &Agent{identity: identity, key: key, sessions: sessions, version: version, fileRateBytes: fileRate}, nil
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
	return socket.JSON(protocol.Message{Type: "inventory", RunUser: account.Username, Hostname: host, Platform: runtime.GOOS + "/" + runtime.GOARCH, Home: home, Shell: a.sessions.shell, Version: a.version, Sessions: sessions, Complete: snapshotErr == nil, BootID: a.sessions.bootID, Capabilities: []string{"directories", "full-inventory", "workspace-control-v1", "workspace-files-v1", "workspace-create-v1", "workspace-rename-v1", "workspace-delete-v1", "workspace-file-direct-v1", "workspace-watch-v1", "workspace-archive-v1"}})
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
	fileWorkers := newFileWorkerPool(a)
	defer fileWorkers.Close()
	var jobs sync.WaitGroup
	workspaceSlots := make(chan struct{}, 8)
	fileSlots := make(chan struct{}, 16)
	defer func() { cancel(); jobs.Wait() }()
	for {
		var msg protocol.Message
		if err = socket.Conn.ReadJSON(&msg); err != nil {
			return err
		}
		switch msg.Type {
		case "file.attach":
			select {
			case fileSlots <- struct{}{}:
			default:
				continue
			}
			jobs.Add(1)
			go func() {
				defer jobs.Done()
				defer func() { <-fileSlots }()
				_ = a.attachFiles(ctx, fileWorkers, msg)
			}()
		case "workspace.register", "workspace.prepare", "workspace.commit", "workspace.abort", "workspace.status":
			select {
			case workspaceSlots <- struct{}{}:
			default:
				_ = socket.JSON(protocol.Message{Type: "result", RequestID: msg.RequestID, TerminalID: msg.TerminalID, ErrorCode: "BUSY", Error: "节点文件服务繁忙，请重试"})
				continue
			}
			jobs.Add(1)
			go func() {
				defer jobs.Done()
				defer func() { <-workspaceSlots }()
				jobCtx, stop := context.WithTimeout(ctx, 35*time.Second)
				defer stop()
				_ = socket.JSON(a.workspaceControl(jobCtx, fileWorkers, msg))
			}()
		case "attach":
			if !msg.ReadOnly {
				a.controlMu.Lock()
				if a.controllers == nil {
					a.controllers = map[string]string{}
				}
				a.controllers[msg.TerminalID] = msg.Ticket
				a.controlMu.Unlock()
			}
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
	f, err := startAttachment(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	link := newTerminalLink(ctx, cancel, socket)
	defer func() {
		cancel()
		link.close()
		socket.Close()
		stopAttachment(cmd, f)
	}()
	go func() { <-ctx.Done(); socket.Close(); _ = f.Close() }()
	go socket.Heartbeat(ctx.Done())
	ack := make(chan int, 128)
	errorsCh := make(chan error, 2)
	go func() {
		for {
			var packet linkPacket
			select {
			case packet = <-link.incoming:
			case <-ctx.Done():
				return
			}
			kind, b := packet.kind, packet.data
			var e error
			if kind == websocket.BinaryMessage {
				if !a.isController(msg) || !link.accepts(packet.route) {
					continue
				}
				if len(b) > 32768 {
					errorsCh <- errors.New("input too large")
					return
				}
				_, e = f.Write(b)
			} else if kind == websocket.TextMessage {
				var frame protocol.Frame
				if json.Unmarshal(b, &frame) != nil {
					continue
				}
				switch frame.Type {
				case "scroll-exit":
					if a.isController(msg) && link.accepts(packet.route) {
						e = a.sessions.leaveHistory(msg.TerminalID)
					}
				case "rtc-offer":
					if packet.route == "relay" {
						link.negotiate(frame.SDP)
					}
				case "probe":
					e = link.probe(packet.route, frame)
				case "route-request":
					e = link.requestRoute(packet.route, frame)
				case "route-commit":
					e = link.commitRoute(packet.route, frame)
				case "resize":
					{
						if !link.accepts(packet.route) {
							continue
						}
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
						e = resizeAttachment(f, cols, rows)
						if e == nil && a.isController(msg) {
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
				if e2 := link.write(websocket.BinaryMessage, buf[:n]); e2 != nil {
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
