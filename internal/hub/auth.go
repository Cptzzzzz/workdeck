package hub

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type login struct {
	Hash, Username, CSRF string
	Token                string
	Expires              int64
}

func (h *Hub) cookieName() string {
	if strings.HasPrefix(h.cfg.PublicURL, "https://") {
		return "__Host-workdeck"
	}
	return "workdeck"
}
func (h *Hub) loginFor(r *http.Request) (login, bool) {
	c, err := r.Cookie(h.cookieName())
	if err != nil {
		return login{}, false
	}
	l := login{Hash: digest(c.Value), CSRF: digest(c.Value + ":csrf"), Token: c.Value}
	err = h.store.db.QueryRow("SELECT username,expires FROM logins WHERE hash=?", l.Hash).Scan(&l.Username, &l.Expires)
	return l, err == nil && l.Expires > time.Now().Unix()
}
func (h *Hub) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	return o == "" || o == h.cfg.PublicURL
}
func (h *Hub) protected(fn func(http.ResponseWriter, *http.Request, login)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l, ok := h.loginFor(r)
		if !ok {
			failure(w, 401, "请先登录")
			return
		}
		if !h.sameOrigin(r) {
			failure(w, 403, "请求来源不匹配")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Workdeck-CSRF")), []byte(l.CSRF)) != 1 {
			failure(w, 403, "请求校验失败，请刷新后重试")
			return
		}
		h.renewLogin(w, &l)
		fn(w, r, l)
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		failure(w, 415, "需要 JSON 请求")
		return false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		failure(w, 400, "请求格式无效")
		return false
	}
	return true
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func (h *Hub) signIn(w http.ResponseWriter, r *http.Request) {
	if !h.sameOrigin(r) {
		failure(w, 403, "请求来源不匹配")
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if proxy, err := netip.ParsePrefix(h.cfg.TrustedProxyCIDR); err == nil {
		if peer, err := netip.ParseAddr(host); err == nil && proxy.Contains(peer) {
			chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
			if client, err := netip.ParseAddr(strings.TrimSpace(chain[len(chain)-1])); err == nil {
				host = client.String()
			}
		}
	}
	h.mu.Lock()
	for ip, old := range h.attempts {
		if time.Since(old.Since) > 15*time.Minute {
			delete(h.attempts, ip)
		}
	}
	a := h.attempts[host]
	if time.Since(a.Since) > 15*time.Minute {
		a = attempt{Since: time.Now()}
	}
	a.Count++
	h.attempts[host] = a
	h.mu.Unlock()
	if a.Count > 30 {
		failure(w, 429, "尝试次数过多，请稍后重试")
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	var hash []byte
	err := h.store.db.QueryRow("SELECT password_hash FROM accounts WHERE username=?", in.Username).Scan(&hash)
	if err != nil {
		hash = h.dummyHash
	}
	if e := comparePassword(hash, in.Password); e != nil || err != nil {
		failure(w, 401, "用户名或密码错误")
		return
	}
	token := randomID()
	expires := time.Now().Add(h.cfg.SessionTTL).Unix()
	if _, err = h.store.db.Exec("INSERT INTO logins VALUES(?,?,?)", digest(token), in.Username, expires); err != nil {
		failure(w, 500, "保存登录状态失败")
		return
	}
	_, _ = h.store.db.Exec("DELETE FROM logins WHERE expires<?", time.Now().Unix())
	h.setLoginCookie(w, token, expires)
	respond(w, 200, map[string]string{"username": in.Username, "csrf": digest(token + ":csrf")})
}

func (h *Hub) setLoginCookie(w http.ResponseWriter, token string, expires int64) {
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(h.cfg.PublicURL, "https://"), SameSite: http.SameSiteStrictMode, Expires: time.Unix(expires, 0).UTC(), MaxAge: int(time.Until(time.Unix(expires, 0)).Seconds())})
}

func (h *Hub) renewLogin(w http.ResponseWriter, l *login) {
	// Keep devices independent. Renew at most once per day (or a quarter of a short TTL).
	interval := 24 * time.Hour
	if h.cfg.SessionTTL/4 < interval {
		interval = h.cfg.SessionTTL / 4
	}
	if time.Until(time.Unix(l.Expires, 0)) > h.cfg.SessionTTL-interval {
		return
	}
	expires := time.Now().Add(h.cfg.SessionTTL).Unix()
	result, err := h.store.db.Exec("UPDATE logins SET expires=? WHERE hash=? AND expires=?", expires, l.Hash, l.Expires)
	if err != nil {
		return
	}
	changed, _ := result.RowsAffected()
	if changed == 1 {
		l.Expires = expires
		h.setLoginCookie(w, l.Token, expires)
	}
}
func (h *Hub) signOut(w http.ResponseWriter, r *http.Request, l login) {
	_, _ = h.store.db.Exec("DELETE FROM logins WHERE hash=?", l.Hash)
	h.closeLogin(l.Hash)
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(), Value: "", Path: "/", HttpOnly: true, Secure: strings.HasPrefix(h.cfg.PublicURL, "https://"), SameSite: http.SameSiteStrictMode, MaxAge: -1})
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Hub) changePassword(w http.ResponseWriter, r *http.Request, l login) {
	var in struct {
		Current  string `json:"current"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := validatePassword(in.Password); err != nil {
		failure(w, 400, err.Error())
		return
	}
	var old []byte
	_ = h.store.db.QueryRow("SELECT password_hash FROM accounts WHERE username=?", l.Username).Scan(&old)
	if comparePassword(old, in.Current) != nil {
		failure(w, 403, "当前密码错误")
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		failure(w, 400, "密码格式无效")
		return
	}
	tx, err := h.store.db.Begin()
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE accounts SET password_hash=? WHERE username=?", hash, l.Username); err == nil {
		_, err = tx.Exec("DELETE FROM logins WHERE username=? AND hash<>?", l.Username, l.Hash)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	h.closeOtherLogins(l.Hash)
	respond(w, 200, map[string]bool{"ok": true})
}
func signaturePayload(r *http.Request) string {
	return r.Method + "\n" + r.URL.RequestURI() + "\n" + r.Header.Get("X-Workdeck-Time") + "\n" + r.Header.Get("X-Workdeck-Nonce")
}
func (h *Hub) agentIdentity(r *http.Request) (string, bool) {
	id := r.Header.Get("X-Workdeck-Node")
	timestamp, err := strconv.ParseInt(r.Header.Get("X-Workdeck-Time"), 10, 64)
	if err != nil || time.Now().Unix()-timestamp > 60 || timestamp-time.Now().Unix() > 60 {
		return "", false
	}
	nonce := r.Header.Get("X-Workdeck-Nonce")
	if len(nonce) != 48 {
		return "", false
	}
	var key string
	err = h.store.db.QueryRow("SELECT public_key FROM nodes WHERE id=? AND revoked=0", id).Scan(&key)
	if err != nil {
		return "", false
	}
	pub, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return "", false
	}
	sig, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Workdeck-Signature"))
	if err != nil || !ed25519.Verify(pub, []byte(signaturePayload(r)), sig) {
		return "", false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	n := id + ":" + nonce
	if _, exists := h.nonces[n]; exists {
		return "", false
	}
	for k, t := range h.nonces {
		if time.Since(t) > 2*time.Minute {
			delete(h.nonces, k)
		}
	}
	h.nonces[n] = time.Now()
	return id, true
}
func (h *Hub) enroll(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token     string `json:"token"`
		Name      string `json:"name"`
		PublicKey string `json:"public_key"`
		Proof     string `json:"proof"`
	}
	if !decode(w, r, &in) {
		return
	}
	pub, e := base64.StdEncoding.DecodeString(in.PublicKey)
	proof, e2 := base64.StdEncoding.DecodeString(in.Proof)
	if e != nil || e2 != nil || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, []byte("workdeck-enroll:"+in.Token), proof) || len(strings.TrimSpace(in.Name)) == 0 || len(in.Name) > 100 {
		failure(w, 400, "节点身份信息无效")
		return
	}
	tx, err := h.store.db.Begin()
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	defer tx.Rollback()
	var claimedID, claimedKey string
	if tx.QueryRow("SELECT node_id,public_key FROM enrollment_claims WHERE hash=? AND expires>?", digest(in.Token), time.Now().Unix()).Scan(&claimedID, &claimedKey) == nil {
		if claimedKey != in.PublicKey {
			failure(w, 403, "加入令牌已用于其他节点身份")
			return
		}
		var revoked int
		if tx.QueryRow("SELECT revoked FROM nodes WHERE id=?", claimedID).Scan(&revoked) != nil || revoked != 0 {
			failure(w, 403, "节点身份已撤销")
			return
		}
		// Recover a lost HTTP response without creating a second node identity.
		respond(w, 201, map[string]string{"node_id": claimedID})
		return
	}
	var expires int64
	if tx.QueryRow("SELECT expires FROM enrollments WHERE hash=? AND expires>?", digest(in.Token), time.Now().Unix()).Scan(&expires) != nil {
		failure(w, 403, "加入令牌无效、过期或已使用")
		return
	}
	res, err := tx.Exec("DELETE FROM enrollments WHERE hash=? AND expires>?", digest(in.Token), time.Now().Unix())
	if err != nil {
		failure(w, 500, "保存失败")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		failure(w, 403, "加入令牌无效、过期或已使用")
		return
	}
	id := randomID()
	_, err = tx.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", id, strings.TrimSpace(in.Name), in.PublicKey)
	if err == nil {
		_, err = tx.Exec("INSERT INTO enrollment_claims VALUES(?,?,?,?)", digest(in.Token), id, in.PublicKey, expires)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		failure(w, 500, "保存节点失败")
		return
	}
	respond(w, 201, map[string]string{"node_id": id})
}
func validateID(id string) error {
	if len(id) != 48 {
		return fmt.Errorf("invalid id")
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return fmt.Errorf("invalid id")
		}
	}
	return nil
}
