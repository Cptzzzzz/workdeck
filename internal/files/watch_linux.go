//go:build linux

package files

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// DirectoryWatch only emits invalidations. It never sends names or file data;
// clients must re-read their authorized directory snapshots after an event.
type DirectoryWatch struct {
	engine     *Engine
	workspace  string
	revision   int64
	mu         sync.Mutex
	fd         int
	generation uint64
	entries    []watchedDirectory
	closed     bool
}
type watchedDirectory struct {
	path   string
	file   *os.File
	device uint64
	inode  uint64
}
type WatchEvent struct {
	Generation uint64 `json:"generation"`
	Changed    bool   `json:"changed"`
	Reset      bool   `json:"reset"`
}

func (e *Engine) NewDirectoryWatch(ctx context.Context, workspace string, revision int64, paths []string) (*DirectoryWatch, error) {
	w := &DirectoryWatch{engine: e, workspace: workspace, revision: revision, fd: -1}
	if err := w.Set(ctx, paths); err != nil {
		return nil, err
	}
	return w, nil
}

// Set installs a fresh complete subscription before releasing the previous
// one. The caller must reconcile its visible tree after changing the set.
func (w *DirectoryWatch) Set(ctx context.Context, paths []string) error {
	if len(paths) == 0 || len(paths) > 64 {
		return fail("INVALID_WATCH", "监听目录数量无效")
	}
	root, release, err := w.engine.acquire(ctx, w.workspace, w.revision)
	if err != nil {
		return err
	}
	defer release()
	fd, err := unix.InotifyInit1(unix.IN_NONBLOCK | unix.IN_CLOEXEC)
	if err != nil {
		return err
	}
	var entries []watchedDirectory
	installed := false
	defer func() {
		if !installed {
			unix.Close(fd)
			for _, e := range entries {
				e.file.Close()
			}
		}
	}()
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		if err := validPath(path, true); err != nil {
			return err
		}
		if seen[path] {
			return fail("INVALID_WATCH", "监听目录重复")
		}
		seen[path] = true
		if err := ctx.Err(); err != nil {
			return err
		}
		f, err := root.root.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK|unix.O_DIRECTORY, 0)
		if err != nil {
			return fail("NOT_FOUND", "目录不存在或无法访问")
		}
		st, err := f.Stat()
		if err != nil || !st.IsDir() {
			f.Close()
			return fail("INVALID_WATCH", "只能监听工作区目录")
		}
		var native unix.Stat_t
		if err := unix.Fstat(int(f.Fd()), &native); err != nil {
			f.Close()
			return err
		}
		entries = append(entries, watchedDirectory{path: path, file: f, device: uint64(native.Dev), inode: native.Ino})
		mask := uint32(unix.IN_CREATE | unix.IN_DELETE | unix.IN_MOVED_FROM | unix.IN_MOVED_TO | unix.IN_MODIFY | unix.IN_CLOSE_WRITE | unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF | unix.IN_ONLYDIR)
		if _, err := unix.InotifyAddWatch(fd, fmt.Sprintf("/proc/self/fd/%d", f.Fd()), mask); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return os.ErrClosed
	}
	oldFD, oldEntries := w.fd, w.entries
	w.fd, w.entries = fd, entries
	w.generation++
	installed = true
	if oldFD >= 0 {
		unix.Close(oldFD)
	}
	for _, e := range oldEntries {
		e.file.Close()
	}
	return nil
}

// Wait bounds individual polls so Close, Set and context cancellation cannot
// be held indefinitely. Invalidations are hints; overflow and identity changes
// require a full reconciliation.
func (w *DirectoryWatch) Wait(ctx context.Context, timeout time.Duration) (WatchEvent, error) {
	if timeout < 0 || timeout > 25*time.Second {
		return WatchEvent{}, fail("INVALID_WATCH", "监听等待时间无效")
	}
	deadline := time.Now().Add(timeout)
	var nextValidation time.Time
	for {
		if err := ctx.Err(); err != nil {
			return WatchEvent{}, err
		}
		var root *workspaceHandle
		var release func()
		var err error
		if time.Now().After(nextValidation) {
			root, release, err = w.engine.acquire(ctx, w.workspace, w.revision)
			if err != nil {
				return WatchEvent{}, err
			}
			nextValidation = time.Now().Add(time.Second)
		}
		w.mu.Lock()
		if w.closed {
			w.mu.Unlock()
			if release != nil {
				release()
			}
			return WatchEvent{}, os.ErrClosed
		}
		result := WatchEvent{Generation: w.generation}
		if root != nil {
			for _, e := range w.entries {
				st, err := root.root.Stat(e.path)
				if err != nil || !st.IsDir() {
					result.Reset = true
					break
				}
				current := identity(st)
				if current.Device != e.device || current.Inode != e.inode {
					result.Reset = true
					break
				}
			}
		}
		if release != nil {
			release()
		}
		if result.Reset {
			w.mu.Unlock()
			return result, nil
		}
		remaining := time.Until(deadline)
		ms := 0
		if remaining > 0 {
			ms = int(min(remaining, 100*time.Millisecond).Milliseconds())
			if ms < 1 {
				ms = 1
			}
		}
		poll := []unix.PollFd{{Fd: int32(w.fd), Events: unix.POLLIN}}
		_, err = unix.Poll(poll, ms)
		if err != nil && !errors.Is(err, unix.EINTR) {
			w.mu.Unlock()
			return WatchEvent{}, err
		}
		if poll[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 {
			result.Reset = true
		}
		if poll[0].Revents&unix.POLLIN != 0 {
			var buffer [16384]byte
			for batch := 0; batch < 16; batch++ {
				n, readErr := unix.Read(w.fd, buffer[:])
				if errors.Is(readErr, unix.EAGAIN) {
					break
				}
				if readErr != nil {
					w.mu.Unlock()
					return WatchEvent{}, readErr
				}
				if n == 0 {
					result.Reset = true
					break
				}
				for pos := 0; pos < n; {
					if n-pos < unix.SizeofInotifyEvent {
						result.Reset = true
						break
					}
					mask := binary.NativeEndian.Uint32(buffer[pos+4 : pos+8])
					length := binary.NativeEndian.Uint32(buffer[pos+12 : pos+16])
					if uint64(length) > uint64(n-pos-unix.SizeofInotifyEvent) {
						result.Reset = true
						break
					}
					if mask&(unix.IN_Q_OVERFLOW|unix.IN_IGNORED|unix.IN_UNMOUNT|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0 {
						result.Reset = true
					} else {
						result.Changed = true
					}
					pos += unix.SizeofInotifyEvent + int(length)
				}
				if batch == 15 {
					result.Reset = true
				}
			}
		}
		w.mu.Unlock()
		if result.Changed || result.Reset || remaining <= 0 {
			return result, nil
		}
	}
}

func (w *DirectoryWatch) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.fd >= 0 {
		unix.Close(w.fd)
		w.fd = -1
	}
	for _, e := range w.entries {
		e.file.Close()
	}
	w.entries = nil
	return nil
}
