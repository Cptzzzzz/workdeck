package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"workdeck/internal/protocol"
)

// ListDirectories runs as the enrolled OS user and never invokes a shell.
func ListDirectories(ctx context.Context, path string, hidden bool) (*protocol.DirectoryListing, error) {
	if path == "" {
		var err error
		path, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	if !filepath.IsAbs(path) || len(path) > 4096 || strings.ContainsRune(path, 0) {
		return nil, errors.New("目录必须是有效的绝对路径")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return nil, errors.New("目录不存在或无法访问")
	}
	dir, err := os.Open(resolved)
	if err != nil {
		return nil, errors.New("无法读取目录，请检查访问权限")
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		return nil, errors.New("所选路径不是目录")
	}
	listing := &protocol.DirectoryListing{Path: resolved, Parent: filepath.Dir(resolved), Entries: []protocol.Directory{}}
	scanned := 0
	for {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			scanned++
			if scanned > 20000 || len(listing.Entries) >= 2048 {
				listing.Truncated = true
				break
			}
			if !hidden && strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			isDir := entry.IsDir()
			child := filepath.Join(resolved, entry.Name())
			if entry.Type()&os.ModeSymlink != 0 {
				if stat, e := os.Stat(child); e == nil {
					isDir = stat.IsDir()
				}
			}
			if isDir {
				listing.Entries = append(listing.Entries, protocol.Directory{Name: entry.Name(), Path: child})
			}
		}
		if listing.Truncated || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, errors.New("读取目录时发生错误")
		}
	}
	sort.Slice(listing.Entries, func(i, j int) bool { return listing.Entries[i].Name < listing.Entries[j].Name })
	return listing, nil
}
