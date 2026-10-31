package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type processInfo struct {
	parent int
	name   string
	start  string
}
type processSnapshot map[int]processInfo

// Only process names and parent IDs are read. Command lines, environments and
// terminal contents may contain secrets and are intentionally not inspected.
func codexProcesses() processSnapshot {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	result := processSnapshot{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		if info, ok := readProcessInfo(pid); ok {
			result[pid] = info
		}
	}
	return result
}

func readProcessInfo(pid int) (processInfo, bool) {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return processInfo{}, false
	}
	s := string(b)
	first, last := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if first < 0 || last <= first || last+2 >= len(s) {
		return processInfo{}, false
	}
	fields := strings.Fields(s[last+2:])
	if len(fields) < 20 {
		return processInfo{}, false
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return processInfo{}, false
	}
	return processInfo{parent: parent, name: s[first+1 : last], start: fields[19]}, true
}

func currentAncestorCodexKey(pid int) string {
	seen := map[int]bool{}
	for pid > 0 && !seen[pid] {
		seen[pid] = true
		p, ok := readProcessInfo(pid)
		if !ok {
			break
		}
		if key := (processSnapshot{pid: p}).codexKey(pid); key != "" {
			return key
		}
		pid = p.parent
	}
	return ""
}

func (s processSnapshot) codexKey(pid int) string {
	p, ok := s[pid]
	if !ok || p.start == "" || !(p.name == "codex" || strings.HasPrefix(p.name, "codex-")) {
		return ""
	}
	h := sha256.Sum256([]byte(strconv.Itoa(pid) + ":" + p.start))
	return hex.EncodeToString(h[:])
}

func (s processSnapshot) hasKey(root int, key string) bool {
	if key == "" {
		return true
	}
	children := map[int][]int{}
	for pid, p := range s {
		children[p.parent] = append(children[p.parent], pid)
	}
	queue := []int{root}
	seen := map[int]bool{}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		if s.codexKey(pid) == key {
			return true
		}
		queue = append(queue, children[pid]...)
	}
	return false
}

func (s processSnapshot) hasCodex(root int) bool {
	children := map[int][]int{}
	for pid, p := range s {
		children[p.parent] = append(children[p.parent], pid)
	}
	queue := []int{root}
	seen := map[int]bool{}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		p, ok := s[pid]
		if !ok {
			continue
		}
		if p.name == "codex" || strings.HasPrefix(p.name, "codex-") {
			return true
		}
		queue = append(queue, children[pid]...)
	}
	return false
}
