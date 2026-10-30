package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type fileIdentity struct {
	Device uint64
	Inode  uint64
	Size   int64
	Mode   uint32
	UID    uint32
	GID    uint32
	Links  uint64
	Mtime  int64
	Ctime  int64
}

func identity(info os.FileInfo) fileIdentity {
	st := info.Sys().(*syscall.Stat_t)
	return fileIdentity{uint64(st.Dev), st.Ino, info.Size(), uint32(info.Mode()), st.Uid, st.Gid, uint64(st.Nlink), st.Mtim.Sec*1e9 + st.Mtim.Nsec, st.Ctim.Sec*1e9 + st.Ctim.Nsec}
}
func entry(name string, info os.FileInfo) Entry {
	kind := "special"
	if info.Mode().IsRegular() {
		kind = "file"
	}
	if info.IsDir() {
		kind = "directory"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		kind = "symlink"
	}
	return Entry{Name: name, Kind: kind, Size: info.Size(), Mode: uint32(info.Mode().Perm()), Modified: info.ModTime().UTC().Format(time.RFC3339Nano), Restricted: kind == "special" || kind == "symlink"}
}

func versionFor(original fileIdentity, digest string) string {
	b, _ := json.Marshal(struct {
		Identity fileIdentity
		Digest   string
	}{original, digest})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(b)
}

type Reader struct {
	file       *os.File
	release    func()
	original   fileIdentity
	Metadata   Entry
	snapshot   []byte
	closeOnce  sync.Once
	closeError error
}

func (r *Reader) Close() error {
	r.closeOnce.Do(func() { r.closeError = r.file.Close(); r.release() })
	return r.closeError
}
func (r *Reader) ReadAt(ctx context.Context, offset int64, length int) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if offset < 0 || length < 0 || length > ChunkLimit || offset > r.original.Size {
		return nil, fail("INVALID_RANGE", "读取范围无效")
	}
	before, err := r.file.Stat()
	if err != nil {
		return nil, err
	}
	if identity(before) != r.original {
		return nil, fail("FILE_CHANGED", "文件在读取期间发生改变")
	}
	if int64(length) > r.original.Size-offset {
		length = int(r.original.Size - offset)
	}
	if r.snapshot != nil {
		return bytes.Clone(r.snapshot[offset : offset+int64(length)]), nil
	}
	b := make([]byte, length)
	n, err := r.file.ReadAt(b, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	after, err := r.file.Stat()
	if err != nil {
		return nil, err
	}
	if identity(after) != r.original {
		return nil, fail("FILE_CHANGED", "文件在读取期间发生改变")
	}
	return b[:n], nil
}

func (e *Engine) OpenRead(ctx context.Context, id string, revision int64, name, version string) (*Reader, error) {
	if err := validPath(name, false); err != nil {
		return nil, err
	}
	r, release, err := e.acquire(ctx, id, revision)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			release()
		}
	}()
	// Nonblocking open prevents a swapped FIFO from hanging a file worker before
	// fstat can reject it. os.Root enforces the directory boundary during open.
	f, err := r.root.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, fail("FILE_UNAVAILABLE", "无法读取文件或链接越过工作区")
	}
	defer func() {
		if !success {
			f.Close()
		}
	}()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fail("SPECIAL_FILE", "仅支持普通文件")
	}
	original := identity(info)
	meta := entry(path.Base(name), info)
	var snapshot []byte
	if original.Size <= TextLimit {
		snapshot, err = io.ReadAll(contextReader{ctx, io.LimitReader(f, TextLimit+1)})
		if err != nil {
			return nil, err
		}
		if int64(len(snapshot)) != original.Size {
			return nil, fail("FILE_CHANGED", "文件在读取期间发生改变")
		}
		sum := sha256.Sum256(snapshot)
		meta.SHA256 = hex.EncodeToString(sum[:])
	}
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if identity(after) != original {
		return nil, fail("FILE_CHANGED", "文件在读取期间发生改变")
	}
	meta.Version = versionFor(original, meta.SHA256)
	if version != "" && meta.Version != version {
		return nil, fail("FILE_CHANGED", "文件版本已改变")
	}
	if leaf, err := r.root.Lstat(name); err == nil && leaf.Mode()&os.ModeSymlink != 0 {
		meta.Kind = "symlink"
		meta.Restricted = true
	}
	success = true
	return &Reader{file: f, release: release, original: original, Metadata: meta, snapshot: snapshot}, nil
}

func (e *Engine) Stat(ctx context.Context, id string, revision int64, name string) (Entry, error) {
	if err := validPath(name, true); err != nil {
		return Entry{}, err
	}
	r, release, err := e.acquire(ctx, id, revision)
	if err != nil {
		return Entry{}, err
	}
	info, err := r.root.Lstat(name)
	release()
	if err != nil {
		return Entry{}, fail("NOT_FOUND", "文件不存在或无法访问")
	}
	if !info.Mode().IsRegular() {
		result := entry(path.Base(name), info)
		if info.IsDir() {
			result.Version = versionFor(identity(info), "")
		}
		return result, nil
	}
	reader, err := e.OpenRead(ctx, id, revision, name, "")
	if err != nil {
		return Entry{}, err
	}
	defer reader.Close()
	return reader.Metadata, nil
}

func (e *Engine) List(ctx context.Context, id string, revision int64, name string, hidden bool, filter string) (Listing, error) {
	result := Listing{Path: name, Entries: []Entry{}}
	if err := validPath(name, true); err != nil {
		return result, err
	}
	r, release, err := e.acquire(ctx, id, revision)
	if err != nil {
		return result, err
	}
	defer release()
	dir, err := r.root.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return result, fail("DIRECTORY_UNAVAILABLE", "无法打开目录")
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		return result, fail("NOT_DIRECTORY", "所选路径不是目录")
	}
	scanned := 0
	for {
		if err = ctx.Err(); err != nil {
			return result, err
		}
		items, readErr := dir.ReadDir(128)
		for _, item := range items {
			scanned++
			if scanned > 20000 {
				result.Truncated = true
				break
			}
			raw := item.Name()
			if !hidden && len(raw) > 0 && raw[0] == '.' {
				continue
			}
			if filter != "" && !strings.Contains(strings.ToLower(raw), strings.ToLower(filter)) {
				continue
			}
			info, err := r.root.Lstat(path.Join(name, raw))
			if err != nil {
				continue
			}
			meta := entry(raw, info)
			if !utf8.ValidString(raw) {
				meta.Name = fmt.Sprintf("%q", raw)
				meta.Restricted = true
			}
			result.Entries = append(result.Entries, meta)
		}
		if result.Truncated || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return result, readErr
		}
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if (a.Kind == "directory") != (b.Kind == "directory") {
			return a.Kind == "directory"
		}
		return a.Name < b.Name
	})
	return result, nil
}
