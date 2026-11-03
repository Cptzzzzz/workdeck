package hub

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"workdeck/internal/protocol"
)

func (h *Hub) nodeProxyKey(create bool) ([]byte, error) {
	path := filepath.Join(h.cfg.DataDir, "node-proxy.key")
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && create {
		var count int
		if e := h.store.db.QueryRow("SELECT COUNT(*) FROM node_codex_settings").Scan(&count); e != nil || count != 0 {
			return nil, errors.New("代理密钥缺失，不能覆盖已保存的配置")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		_, err = f.Write(key)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(path)
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || len(key) != 32 {
		return nil, errors.New("代理密钥无效或权限不安全")
	}
	return key, nil
}

func (h *Hub) nodeProxyCipher(create bool) (cipher.AEAD, error) {
	key, err := h.nodeProxyKey(create)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (h *Hub) nodeCodexSettings(w http.ResponseWriter, r *http.Request, l login) {
	w.Header().Set("Cache-Control", "no-store")
	id := r.PathValue("id")
	var exists int
	if h.store.db.QueryRow("SELECT 1 FROM nodes WHERE id=? AND revoked=0", id).Scan(&exists) != nil {
		failure(w, 404, "节点不存在")
		return
	}
	if r.Method == "GET" {
		var sealed []byte
		err := h.store.db.QueryRow("SELECT proxy FROM node_codex_settings WHERE node_id=?", id).Scan(&sealed)
		if errors.Is(err, sql.ErrNoRows) {
			respond(w, 200, map[string]string{"proxy": ""})
			return
		}
		if err != nil {
			failure(w, 500, "读取节点代理失败")
			return
		}
		box, err := h.nodeProxyCipher(false)
		if err != nil || len(sealed) < box.NonceSize() {
			failure(w, 500, "节点代理配置无法解密，请检查主服务密钥")
			return
		}
		plain, err := box.Open(nil, sealed[:box.NonceSize()], sealed[box.NonceSize():], []byte(id))
		if err != nil {
			failure(w, 500, "节点代理配置无法解密")
			return
		}
		respond(w, 200, map[string]string{"proxy": string(plain)})
		return
	}
	var in struct {
		Proxy string `json:"proxy"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Proxy = strings.TrimSpace(in.Proxy)
	if in.Proxy != "" {
		opts := protocol.CodexLaunchOptions{ProxyMode: "custom", Proxy: in.Proxy, Approval: "on-request", Sandbox: "workspace-write"}
		if err := opts.Validate(); err != nil {
			failure(w, 400, err.Error())
			return
		}
	}
	h.nodeMu.Lock()
	defer h.nodeMu.Unlock()
	// Revocation may have completed while the request body was being read.
	if h.store.db.QueryRow("SELECT 1 FROM nodes WHERE id=? AND revoked=0", id).Scan(&exists) != nil {
		failure(w, 404, "节点不存在")
		return
	}
	if in.Proxy == "" {
		if _, err := h.store.db.Exec("DELETE FROM node_codex_settings WHERE node_id=?", id); err != nil {
			failure(w, 500, "保存节点代理失败")
			return
		}
	} else {
		box, err := h.nodeProxyCipher(true)
		if err != nil {
			failure(w, 500, "节点代理密钥不可用，请检查主服务数据目录")
			return
		}
		nonce := make([]byte, box.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			failure(w, 500, "生成代理加密参数失败")
			return
		}
		sealed := box.Seal(nonce, nonce, []byte(in.Proxy), []byte(id))
		if _, err = h.store.db.Exec("INSERT INTO node_codex_settings(node_id,proxy) VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET proxy=excluded.proxy", id, sealed); err != nil {
			failure(w, 500, "保存节点代理失败")
			return
		}
	}
	h.publishState()
	respond(w, 200, map[string]bool{"ok": true})
}
