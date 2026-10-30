package files

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

type workspaceHandle struct {
	spec     Workspace
	root     *os.Root
	mu       sync.RWMutex
	draining bool // guarded by Engine.mu
}

type Engine struct {
	dir          string
	db           *sql.DB
	mu           sync.Mutex
	commit       sync.Mutex
	roots        map[string]*workspaceHandle
	closed       bool
	now          func() time.Time
	maxUpload    int64
	afterPrepare func() error
	afterRename  func() error
}

func Open(dir string) (*Engine, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fail("INVALID_STATE_DIR", "文件服务状态目录无效")
	}
	if err = os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "files.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,terminal_id TEXT NOT NULL,root_path TEXT NOT NULL,revision INTEGER NOT NULL,user_name TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,version TEXT NOT NULL DEFAULT '',spec TEXT NOT NULL,temp_path TEXT NOT NULL DEFAULT '',temp_device TEXT NOT NULL DEFAULT '',temp_inode TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS root_changes(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,old_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,candidate TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_prepared_root_change ON root_changes(workspace_id) WHERE state='prepared';
 CREATE INDEX IF NOT EXISTS operations_workspace ON operations(workspace_id);`
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(filepath.Join(dir, "files.db"), 0600); err != nil {
		db.Close()
		return nil, err
	}
	e := &Engine{dir: dir, db: db, roots: map[string]*workspaceHandle{}, now: time.Now, maxUpload: 1 << 30}
	return e, nil
}

func (e *Engine) Close() error {
	e.commit.Lock()
	defer e.commit.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	e.closed = true
	for _, r := range e.roots {
		r.mu.Lock()
		r.root.Close()
		r.mu.Unlock()
	}
	return e.db.Close()
}

func (e *Engine) RegisterWorkspace(ctx context.Context, spec Workspace) (Workspace, error) {
	if !validID(spec.ID) || !validID(spec.TerminalID) || spec.Revision < 1 || !filepath.IsAbs(spec.Root) {
		return Workspace{}, fail("INVALID_WORKSPACE", "工作区参数无效")
	}
	current, err := user.LookupId(strconv.Itoa(os.Geteuid()))
	if err != nil {
		return Workspace{}, err
	}
	if spec.User != "" && spec.User != current.Username {
		return Workspace{}, fail("ACCOUNT_MISMATCH", "工作区账户与文件工作进程不匹配")
	}
	spec.User = current.Username
	resolved, err := filepath.EvalSymlinks(spec.Root)
	if err != nil {
		return Workspace{}, fail("ROOT_UNAVAILABLE", "工作区目录不存在或无法访问")
	}
	spec.Root = resolved
	root, err := os.OpenRoot(spec.Root)
	if err != nil {
		return Workspace{}, fail("ROOT_UNAVAILABLE", "无法打开工作区目录")
	}
	defer root.Close()
	st, err := root.Stat(".")
	if err != nil {
		return Workspace{}, err
	}
	sys := st.Sys().(*syscall.Stat_t)
	spec.Device = uint64(sys.Dev)
	spec.Inode = sys.Ino
	e.commit.Lock()
	defer e.commit.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return Workspace{}, os.ErrClosed
	}
	_, err = e.db.ExecContext(ctx, `INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,?,?)`, spec.ID, spec.TerminalID, spec.Root, spec.Revision, spec.User, strconv.FormatUint(spec.Device, 10), strconv.FormatUint(spec.Inode, 10))
	if err != nil {
		return Workspace{}, err
	}
	saved, err := e.workspaceRecord(ctx, spec.ID)
	if err != nil {
		return Workspace{}, err
	}
	if saved != spec {
		return Workspace{}, fail("WORKSPACE_CONFLICT", "工作区记录或目录身份已改变，请重新确认")
	}
	return saved, nil
}

func (e *Engine) workspaceRecord(ctx context.Context, id string) (Workspace, error) {
	var w Workspace
	var device, inode string
	err := e.db.QueryRowContext(ctx, `SELECT id,terminal_id,root_path,revision,user_name,device,inode FROM workspaces WHERE id=?`, id).Scan(&w.ID, &w.TerminalID, &w.Root, &w.Revision, &w.User, &device, &inode)
	if errors.Is(err, sql.ErrNoRows) {
		return w, fail("WORKSPACE_NOT_FOUND", "工作区不存在")
	}
	if err != nil {
		return w, err
	}
	w.Device, err = strconv.ParseUint(device, 10, 64)
	if err != nil {
		return w, err
	}
	w.Inode, err = strconv.ParseUint(inode, 10, 64)
	return w, err
}

// WorkspaceIdentity reads the durable identity without opening the root. It
// lets the Agent bind private worker requests to its own terminal record even
// when the directory has temporarily disappeared.
func (e *Engine) WorkspaceIdentity(ctx context.Context, id, terminalID string) (Workspace, error) {
	w, err := e.workspaceRecord(ctx, id)
	if err != nil {
		return Workspace{}, err
	}
	if w.TerminalID != terminalID {
		return Workspace{}, fail("OPERATION_SCOPE", "工作区不属于此终端")
	}
	return w, nil
}

func (e *Engine) acquire(ctx context.Context, id string, revision int64) (*workspaceHandle, func(), error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil, nil, os.ErrClosed
	}
	r := e.roots[id]
	if r == nil {
		spec, err := e.workspaceRecord(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		root, err := os.OpenRoot(spec.Root)
		if err != nil {
			return nil, nil, fail("ROOT_UNAVAILABLE", "工作区目录不可访问")
		}
		info, err := root.Stat(".")
		if err != nil {
			root.Close()
			return nil, nil, err
		}
		st := info.Sys().(*syscall.Stat_t)
		if uint64(st.Dev) != spec.Device || st.Ino != spec.Inode {
			root.Close()
			return nil, nil, fail("ROOT_REPLACED", "原工作区目录已被替换，请重新绑定")
		}
		r = &workspaceHandle{spec: spec, root: root}
		e.roots[id] = r
	}
	if r.draining {
		return nil, nil, fail("WORKSPACE_BUSY", "工作区正在切换目录")
	}
	r.mu.RLock()
	if r.spec.Revision != revision {
		r.mu.RUnlock()
		return nil, nil, fail("STALE_WORKSPACE", "工作区根目录已改变")
	}
	return r, r.mu.RUnlock, nil
}

// ValidateWorkspace rejects stale directory snapshots after a root change.
func (e *Engine) ValidateWorkspace(ctx context.Context, id string, revision int64) error {
	_, release, err := e.acquire(ctx, id, revision)
	if err != nil {
		return err
	}
	release()
	return nil
}
