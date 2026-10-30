// Package files manages bounded workspace file operations independently of
// terminal processes. It never imports terminal lifecycle or service managers.
package files

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	TextLimit      int64 = 5 << 20
	ChunkLimit           = 32 << 10
	ResultLifetime       = 7 * 24 * time.Hour
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string        { return e.Message }
func fail(code, message string) error { return &Error{code, message} }
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "IO_ERROR"
}

type Workspace struct {
	ID         string `json:"id"`
	TerminalID string `json:"terminal_id"`
	Root       string `json:"root_path"`
	Revision   int64  `json:"root_revision"`
	User       string `json:"run_user"`
	Device     uint64 `json:"device"`
	Inode      uint64 `json:"inode"`
}

type Entry struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size"`
	Mode       uint32 `json:"mode"`
	Modified   string `json:"modified"`
	Version    string `json:"version,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	Restricted bool   `json:"restricted,omitempty"`
}

type Listing struct {
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

type WriteSpec struct {
	Path        string `json:"path"`
	BaseVersion string `json:"base_version"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Create      bool   `json:"create,omitempty"`
}

type Operation struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Revision    int64  `json:"root_revision"`
	Kind        string `json:"kind"`
	State       string `json:"state"`
	Offset      int64  `json:"offset"`
	Version     string `json:"version,omitempty"`
	Error       *Error `json:"error,omitempty"`
}

// Mutation IDs carry node-time and a cryptographic nonce so expired unknown
// requests cannot turn into a new mutation after the durable dedup log is pruned.
func NewID(now time.Time) string {
	var id [24]byte
	binary.BigEndian.PutUint64(id[:8], uint64(now.UnixMilli()))
	if _, err := rand.Read(id[8:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(id[:])
}
func validID(id string) bool {
	b, e := hex.DecodeString(id)
	return e == nil && len(b) == 24 && strings.ToLower(id) == id
}
func freshID(id string, now time.Time) bool {
	b, e := hex.DecodeString(id)
	if e != nil || len(b) != 24 {
		return false
	}
	timestamp := binary.BigEndian.Uint64(b[:8])
	if timestamp > uint64(now.Add(5*time.Minute).UnixMilli()) {
		return false
	}
	return timestamp >= uint64(now.Add(-ResultLifetime).UnixMilli())
}
func validPath(value string, rootAllowed bool) error {
	if len(value) > 4096 || !utf8.ValidString(value) || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "/") {
		return fail("INVALID_PATH", "路径必须是工作区内的相对路径")
	}
	if value == "." && rootAllowed {
		return nil
	}
	if value == "" || value == "." || path.Clean(value) != value {
		return fail("INVALID_PATH", "路径包含无效组件")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == "." || part == "" {
			return fail("INVALID_PATH", "路径不能越过工作区")
		}
	}
	return nil
}
func fingerprint(value any) string {
	b, _ := json.Marshal(value)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func digestReader(r io.Reader) (string, error) {
	h := sha256.New()
	_, err := io.Copy(h, r)
	return fmt.Sprintf("%x", h.Sum(nil)), err
}
