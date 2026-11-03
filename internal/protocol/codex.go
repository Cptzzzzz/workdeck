package protocol

import (
	"errors"
	"net/url"
	"strings"
)

// CodexLaunchOptions is sent once over the authenticated control channel. Its
// proxy is stored only in the node's private launch file, never in inventories.
type CodexLaunchOptions struct {
	ProxyMode string `json:"proxy_mode"`
	Proxy     string `json:"proxy,omitempty"`
	Approval  string `json:"approval"`
	Sandbox   string `json:"sandbox"`
	Model     string `json:"model,omitempty"`
	Effort    string `json:"effort,omitempty"`
	Resume    string `json:"resume,omitempty"`
}

func (o *CodexLaunchOptions) Validate() error {
	if o == nil {
		return nil
	}
	switch o.ProxyMode {
	case "inherit", "none":
		if o.Proxy != "" {
			return errors.New("继承或禁用代理时不能指定代理地址")
		}
	case "custom":
		u, e := url.Parse(o.Proxy)
		if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" && u.Scheme != "socks5h") || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || len(o.Proxy) > 2048 || strings.ContainsAny(o.Proxy, "\x00\r\n") {
			return errors.New("代理地址无效，请使用 HTTP、HTTPS 或 SOCKS5 地址")
		}
	default:
		return errors.New("代理模式无效")
	}
	if o.Approval != "on-request" && o.Approval != "never" {
		return errors.New("审批模式无效")
	}
	if o.Sandbox != "read-only" && o.Sandbox != "workspace-write" && o.Sandbox != "danger-full-access" {
		return errors.New("沙箱模式无效")
	}
	switch o.Effort {
	case "", "minimal", "low", "medium", "high", "xhigh":
	default:
		return errors.New("推理强度无效")
	}
	if len(o.Model) > 128 || strings.ContainsAny(o.Model, "\x00\r\n") {
		return errors.New("模型名称无效")
	}
	if o.Resume != "" {
		if len(o.Resume) > 64 {
			return errors.New("会话标识无效")
		}
		for _, c := range o.Resume {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c == '-') {
				return errors.New("会话标识无效")
			}
		}
	}
	return nil
}

// Deliberately excludes the goal objective and conversation contents.
type CodexGoal struct {
	Status          string `json:"status"`
	TokensUsed      int64  `json:"tokens_used"`
	TokenBudget     *int64 `json:"token_budget,omitempty"`
	TimeUsedSeconds int64  `json:"time_used_seconds"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at,omitempty"`
}

type CodexHistoryEntry struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	UpdatedAt int64  `json:"updated_at"`
}

type CodexHistory struct {
	Cwd     string              `json:"cwd"`
	RunUser string              `json:"run_user,omitempty"`
	Entries []CodexHistoryEntry `json:"entries"`
	Cursor  string              `json:"cursor,omitempty"`
}
