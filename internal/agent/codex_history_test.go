package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCodexHistoryFiltersReturnedDirectoriesInsteadOfBrokenServerFilter(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project with spaces")
	alias := filepath.Join(root, "alias")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	calls := 0
	call := func(method string, params, out any) error {
		if method != "thread/list" {
			t.Fatal("history query must not load or resume threads", method)
		}
		p := params.(map[string]any)
		if _, ok := p["cwd"]; ok {
			t.Fatal("server cwd filter reintroduced; it omits migrated paginated histories")
		}
		if len(p["modelProviders"].([]string)) != 0 {
			t.Fatal("provider filter hides history")
		}
		var data []map[string]any
		next := ""
		if calls == 0 {
			data = []map[string]any{{"id": "elsewhere", "name": "Other directory", "cwd": root}}
			next = "older-page"
		} else {
			if p["cursor"] != "older-page" {
				t.Fatal("cursor not passed")
			}
			data = []map[string]any{
				{"id": "target", "name": "Renamed development task", "preview": "private full prompt should not be used", "cwd": project, "updatedAt": 123},
				{"id": "duplicate", "name": "Alias task", "cwd": alias},
				{"id": "target", "name": "Duplicate id", "cwd": project},
				{"id": "child", "name": "Agent task", "cwd": project, "parentThreadId": "target"},
				{"id": "temporary", "name": "Ephemeral", "cwd": project, "ephemeral": true},
				{"id": "nested", "name": "Nested directory", "cwd": filepath.Join(project, "child")},
			}
		}
		calls++
		b, _ := json.Marshal(map[string]any{"data": data, "nextCursor": next})
		return json.Unmarshal(b, out)
	}
	page, err := collectCodexHistory(call, alias, "")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(page.Entries) != 2 || page.Entries[0].Title != "Renamed development task" || page.Cursor != "" {
		t.Fatalf("incomplete or incorrectly scoped history: %+v", page)
	}
	b, _ := json.Marshal(page)
	if strings.Contains(string(b), "private full prompt") {
		t.Fatal("preview leaked despite explicit title")
	}
}

func TestCodexHistoryPreservesPaginationAndBoundsScanning(t *testing.T) {
	calls := 0
	call := func(_ string, params, out any) error {
		calls++
		b, _ := json.Marshal(map[string]any{"data": []any{}, "nextCursor": strconv.Itoa(calls)})
		return json.Unmarshal(b, out)
	}
	page, err := collectCodexHistory(call, t.TempDir(), "")
	if err != nil || calls != 5 || page.Cursor != "5" {
		t.Fatal("unbounded history scan or lost cursor", calls, page, err)
	}
	if title := historyTitle("  ", "fallback\n  title"); title != "fallback title" {
		t.Fatal(title)
	}
	if len([]rune(historyTitle(strings.Repeat("中", 200), ""))) != 181 {
		t.Fatal("title limit is not Unicode safe")
	}
}

func TestCodexHistoryCancellationStopsQueryChildren(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	script := "#!/bin/sh\nsleep 60 &\nprintf '%s' \"$!\" > " + shellQuote(pidFile) + "\nwait\n"
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := ListCodexHistory(ctx, dir, ""); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	var bytes []byte
	for time.Now().Before(deadline) {
		bytes, _ = os.ReadFile(pidFile)
		if len(bytes) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled query succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("query did not stop on cancellation")
	}
	pid, err := strconv.Atoi(string(bytes))
	if err != nil {
		t.Fatal("test query did not start its child", err)
	}
	for until := time.Now().Add(time.Second); time.Now().Before(until); {
		stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
		if os.IsNotExist(err) || strings.Contains(string(stat), ") Z ") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("query child survived cancellation")
}
