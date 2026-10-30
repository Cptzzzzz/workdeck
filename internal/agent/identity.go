package agent

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Identity struct {
	Hub        string `json:"hub"`
	NodeID     string `json:"node_id"`
	Name       string `json:"name"`
	PrivateKey string `json:"private_key"`
}

func atomicJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	e := f.Close()
	if err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func validateHub(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Path != "" && u.Path != "/" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid Hub URL")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return errors.New("Hub URL must use HTTPS")
	}
	return nil
}
func Enroll(dir, hub, name, token string) error {
	hub = strings.TrimRight(hub, "/")
	if err := validateHub(hub); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, "identity.json")
	if _, err := os.Stat(path); err == nil {
		return errors.New("identity already exists; use a different data directory to enroll another node")
	}
	// Persist the key before using the one-time token, so a disk error cannot lose a successful enrollment key.
	pendingPath := filepath.Join(dir, "enrollment.json")
	identity := Identity{Hub: hub, Name: name}
	if b, err := os.ReadFile(pendingPath); err == nil {
		if err = json.Unmarshal(b, &identity); err != nil {
			return err
		}
		if identity.Hub != hub || identity.Name != name {
			return errors.New("pending enrollment belongs to a different Hub or name")
		}
	}
	var priv ed25519.PrivateKey
	if identity.PrivateKey == "" {
		_, priv, _ = ed25519.GenerateKey(rand.Reader)
		identity.PrivateKey = base64.StdEncoding.EncodeToString(priv)
		if err := atomicJSON(pendingPath, identity); err != nil {
			return err
		}
	} else {
		b, e := base64.StdEncoding.DecodeString(identity.PrivateKey)
		if e != nil || len(b) != ed25519.PrivateKeySize {
			return errors.New("invalid pending identity")
		}
		priv = ed25519.PrivateKey(b)
	}
	public := priv.Public().(ed25519.PublicKey)
	payload, _ := json.Marshal(map[string]string{"token": token, "name": name, "public_key": base64.StdEncoding.EncodeToString(public), "proof": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("workdeck-enroll:"+token)))})
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Post(hub+"/api/agent/enroll", "application/json", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 65536))
	if res.StatusCode != 201 {
		return fmt.Errorf("enrollment rejected (%d): %s", res.StatusCode, body)
	}
	var out struct {
		NodeID string `json:"node_id"`
	}
	if err = json.Unmarshal(body, &out); err != nil || len(out.NodeID) != 48 {
		return errors.New("invalid enrollment response")
	}
	identity.NodeID = out.NodeID
	if err = atomicJSON(path, identity); err != nil {
		return err
	}
	_ = os.Remove(pendingPath)
	return nil
}
func loadIdentity(dir string) (Identity, ed25519.PrivateKey, error) {
	var identity Identity
	b, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		return identity, nil, err
	}
	if err = json.Unmarshal(b, &identity); err != nil {
		return identity, nil, err
	}
	if err = validateHub(identity.Hub); err != nil {
		return identity, nil, err
	}
	key, err := base64.StdEncoding.DecodeString(identity.PrivateKey)
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return identity, nil, errors.New("invalid node identity")
	}
	return identity, key, nil
}
func nonce() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func signedHeaders(identity Identity, key ed25519.PrivateKey, path string) http.Header {
	h := http.Header{}
	h.Set("X-Workdeck-Node", identity.NodeID)
	h.Set("X-Workdeck-Time", strconv.FormatInt(time.Now().Unix(), 10))
	h.Set("X-Workdeck-Nonce", nonce())
	payload := "GET\n" + path + "\n" + h.Get("X-Workdeck-Time") + "\n" + h.Get("X-Workdeck-Nonce")
	h.Set("X-Workdeck-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(payload))))
	return h
}
