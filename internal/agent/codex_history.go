package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workdeck/internal/protocol"
)

type historyCall func(string, any, any) error

// ListCodexHistory only asks Codex for metadata. It never resumes a thread or
// reads model turns. The short-lived backend belongs to this request alone.
func ListCodexHistory(ctx context.Context, cwd, cursor string) (*protocol.CodexHistory, error) {
	if !filepath.IsAbs(cwd) || len(cwd) > 4096 || strings.ContainsRune(cwd, 0) || len(cursor) > 4096 {
		return nil, errors.New("目录或分页参数无效")
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return nil, errors.New("工作目录不存在或无法访问")
	}
	bin, err := exec.LookPath("codex")
	if err != nil {
		return nil, errors.New("节点服务账户的 PATH 中找不到 Codex")
	}
	cmd := exec.CommandContext(ctx, bin, "app-server", "--listen", "stdio://")
	cmd.Dir = cwd
	cmd.WaitDelay = time.Second
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return nil, errors.New("无法启动 Codex 历史查询")
	}
	defer func() { _ = in.Close(); _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); _ = cmd.Wait() }()
	scan := bufio.NewScanner(out)
	scan.Buffer(make([]byte, 4096), 8<<20)
	encoder := json.NewEncoder(in)
	sequence := 0
	call := func(method string, params, result any) error {
		sequence++
		if err := encoder.Encode(map[string]any{"id": sequence, "method": method, "params": params}); err != nil {
			return errors.New("Codex 查询连接已断开")
		}
		for scan.Scan() {
			var response struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(scan.Bytes(), &response) != nil {
				return errors.New("Codex 返回了无效的查询响应")
			}
			if response.ID != sequence {
				continue
			}
			if len(response.Error) > 0 && string(response.Error) != "null" {
				return errors.New("节点 Codex 无法读取历史对话，请检查版本和账户配置")
			}
			return json.Unmarshal(response.Result, result)
		}
		if ctx.Err() != nil {
			return errors.New("读取 Codex 历史超时，请重试")
		}
		return errors.New("Codex 历史查询提前退出")
	}
	var initialized json.RawMessage
	if err = call("initialize", map[string]any{"clientInfo": map[string]string{"name": "workdeck_history", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &initialized); err != nil {
		return nil, err
	}
	if err = encoder.Encode(map[string]string{"method": "initialized"}); err != nil {
		return nil, errors.New("Codex 查询初始化失败")
	}
	listing, err := collectCodexHistory(call, cwd, cursor)
	if err == nil {
		if account, e := serviceUser(); e == nil {
			listing.RunUser = account.Username
		}
	}
	return listing, err
}

func historyDirectory(path string) string {
	path = filepath.Clean(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return path
}

func historyTitle(name, preview string) string {
	if strings.TrimSpace(name) == "" {
		name = preview
	}
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "未命名对话"
	}
	runes := []rune(name)
	if len(runes) > 180 {
		name = string(runes[:180]) + "…"
	}
	return name
}

func collectCodexHistory(call historyCall, cwd, cursor string) (*protocol.CodexHistory, error) {
	result := &protocol.CodexHistory{Cwd: cwd, Entries: []protocol.CodexHistoryEntry{}}
	directory := historyDirectory(cwd)
	seen := map[string]bool{}
	// Codex's cwd filter can omit paginated histories after a directory move,
	// even when thread/read and unfiltered thread/list report the correct cwd.
	// Enumerate metadata across providers, then compare actual directories here.
	for page := 0; page < 5; page++ {
		params := map[string]any{"limit": 50, "sortKey": "updated_at", "sortDirection": "desc", "archived": false, "modelProviders": []string{}, "sourceKinds": []string{"cli", "vscode", "exec", "appServer", "unknown"}}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var response struct {
			Data []struct {
				ID        string  `json:"id"`
				Name      string  `json:"name"`
				Preview   string  `json:"preview"`
				Cwd       string  `json:"cwd"`
				UpdatedAt int64   `json:"updatedAt"`
				Parent    *string `json:"parentThreadId"`
				Ephemeral bool    `json:"ephemeral"`
			} `json:"data"`
			Next string `json:"nextCursor"`
		}
		if err := call("thread/list", params, &response); err != nil {
			return nil, err
		}
		for _, t := range response.Data {
			if t.ID == "" || len(t.ID) > 64 || seen[t.ID] || t.Parent != nil || t.Ephemeral || !filepath.IsAbs(t.Cwd) || historyDirectory(t.Cwd) != directory {
				continue
			}
			seen[t.ID] = true
			result.Entries = append(result.Entries, protocol.CodexHistoryEntry{ID: t.ID, Title: historyTitle(t.Name, t.Preview), Cwd: t.Cwd, UpdatedAt: t.UpdatedAt})
		}
		result.Cursor = response.Next
		if response.Next == cursor {
			result.Cursor = ""
		}
		if response.Next == "" || response.Next == cursor || len(result.Entries) >= 50 {
			break
		}
		cursor = response.Next
	}
	return result, nil
}
