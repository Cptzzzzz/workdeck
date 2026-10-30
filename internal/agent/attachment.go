package agent

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func startAttachment(cmd *exec.Cmd) (*os.File, error) {
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 100, Rows: 30})
	if err != nil {
		return nil, err
	}
	// pty's setup ioctls call File.Fd(), which switches the master back to
	// blocking I/O. Restore polling so closing an idle viewer interrupts Read.
	raw, err := f.SyscallConn()
	if err == nil {
		var setupErr error
		err = raw.Control(func(fd uintptr) { setupErr = unix.SetNonblock(int(fd), true) })
		if err == nil {
			err = setupErr
		}
	}
	if err != nil {
		stopAttachment(cmd, f)
		return nil, err
	}
	return f, nil
}

func resizeAttachment(f *os.File, cols, rows uint16) error {
	raw, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var resizeErr error
	// Avoid File.Fd(): each resize must preserve the master's nonblocking mode.
	err = raw.Control(func(fd uintptr) {
		resizeErr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	})
	if err != nil {
		return err
	}
	return resizeErr
}

func stopAttachment(cmd *exec.Cmd, f *os.File) {
	// StartWithSize creates a new process group. Stop only this viewer and its
	// runuser wrapper; the persistent tmux server lives in a separate session.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	_ = f.Close()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
}
