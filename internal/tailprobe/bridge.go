package tailprobe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Bridge runs on the Tailscale host, outside the public Hub container.
// Lookup must verify the peer address against the local Tailscale daemon.
type Bridge struct {
	Origin       string
	LegacyOrigin string
	Secret       []byte
	Lookup       func(context.Context, string) (string, error)
	mu           sync.Mutex
	active       int
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	origin := r.Header.Get("Origin")
	if r.URL.Path != "/probe" || (origin != b.Origin && (b.LegacyOrigin == "" || origin != b.LegacyOrigin)) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") || len(b.Secret) < 32 || b.Lookup == nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		http.Error(w, "invalid peer", http.StatusForbidden)
		return
	}
	ip, err := netip.ParseAddr(peer)
	if err != nil || !(netip.MustParsePrefix("100.64.0.0/10").Contains(ip.Unmap()) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)) {
		http.Error(w, "invalid peer", http.StatusForbidden)
		return
	}
	var req struct {
		Challenge string `json:"challenge"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512))
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || !ValidToken(req.Challenge, 48) {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	if b.active >= 16 {
		b.mu.Unlock()
		http.Error(w, "busy", http.StatusTooManyRequests)
		return
	}
	b.active++
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.active--; b.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	device, err := b.Lookup(ctx, r.RemoteAddr)
	if err != nil || len(device) == 0 || len(device) > 128 {
		http.Error(w, "peer unavailable", http.StatusForbidden)
		return
	}
	tag := DeviceTag(b.Secret, device)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"device": tag, "proof": Proof(b.Secret, req.Challenge, tag)})
}

// LookupTailscaleDevice asks the host's local Tailscale daemon, never a request header.
func LookupTailscaleDevice(ctx context.Context, ip string) (string, error) {
	cmd := exec.CommandContext(ctx, "tailscale", "whois", "--json", "--proto=tcp", ip)
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("tailscale peer lookup failed")
	}
	if len(out) > 1<<20 {
		return "", errors.New("tailscale response too large")
	}
	var info struct {
		Node struct {
			StableID string `json:"StableID"`
		} `json:"Node"`
	}
	if json.Unmarshal(out, &info) != nil || info.Node.StableID == "" {
		return "", fmt.Errorf("tailscale peer identity unavailable")
	}
	return info.Node.StableID, nil
}
