package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"strconv"

	"workdeck/internal/protocol"
)

func serviceUser() (*user.User, error) { return user.LookupId(strconv.Itoa(os.Geteuid())) }
func serviceScope() string {
	if os.Geteuid() == 0 {
		return "system"
	}
	return "user"
}

// Saved ownership keeps pre-migration terminals reachable when an administrator
// moves the Agent service to another account. New sessions use the service user.
func sessionCommand(ctx context.Context, session protocol.Session, program string, args ...string) (*exec.Cmd, error) {
	current, err := serviceUser()
	if err != nil {
		return nil, err
	}
	owner := session.RunUser
	if owner == "" {
		owner = current.Username
	}
	if owner != current.Username {
		if os.Geteuid() != 0 {
			return nil, errors.New("此会话属于其他系统用户")
		}
		if _, err = user.Lookup(owner); err != nil {
			return nil, errors.New("会话原系统用户已不存在")
		}
		args = append([]string{"-u", owner, "--", program}, args...)
		program = "runuser"
	}
	return exec.CommandContext(ctx, program, args...), nil
}
func managerCommand(ctx context.Context, session protocol.Session, program string, args ...string) (*exec.Cmd, error) {
	scope := session.Scope
	if scope == "" {
		scope = serviceScope()
	}
	if scope == "system" {
		if os.Geteuid() != 0 {
			return nil, errors.New("此会话由系统服务管理")
		}
		return exec.CommandContext(ctx, program, args...), nil
	}
	if scope != "user" {
		return nil, errors.New("会话服务范围无效")
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
	if err != nil {
		return nil, err
	}
	runtimeDir := "/run/user/" + account.Uid
	command := []string{"XDG_RUNTIME_DIR=" + runtimeDir, "DBUS_SESSION_BUS_ADDRESS=unix:path=" + runtimeDir + "/bus", program, "--user"}
	command = append(command, args...)
	return sessionCommand(ctx, session, "env", command...)
}
