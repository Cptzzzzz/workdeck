package tailprobe

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Config struct{ Addr, Origin, LegacyOrigin, SecretFile, CertFile, KeyFile string }

// Run binds only to an address assigned to the host's running Tailscale daemon.
func Run(ctx context.Context, cfg Config) error {
	host, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil || port == "" {
		return errors.New("probe requires an explicit Tailscale IP and port")
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return errors.New("probe listen address must be a Tailscale IP")
	}
	allowed := netip.MustParsePrefix("100.64.0.0/10").Contains(ip.Unmap()) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)
	if !allowed {
		return errors.New("probe must listen on a Tailscale IP")
	}
	check, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(check, "tailscale", "ip").Output()
	if err != nil {
		return errors.New("cannot discover Tailscale addresses")
	}
	found := false
	for _, line := range strings.Fields(string(out)) {
		if candidate, e := netip.ParseAddr(line); e == nil && candidate == ip {
			found = true
		}
	}
	if !found {
		return errors.New("probe address is not assigned by local Tailscale")
	}
	u, err := url.Parse(cfg.Origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("origin must be the Workdeck HTTPS origin")
	}
	if cfg.LegacyOrigin != "" {
		legacy, err := url.Parse(cfg.LegacyOrigin)
		if err != nil || legacy.Scheme != "https" || legacy.Host == "" || legacy.User != nil || legacy.Path != "" || legacy.RawQuery != "" || legacy.Fragment != "" {
			return errors.New("legacy origin must be an HTTPS origin")
		}
	}
	key, err := os.ReadFile(cfg.SecretFile)
	if err != nil || len(key) < 32 || len(key) > 4096 {
		return errors.New("probe secret file must contain 32–4096 bytes")
	}
	if cfg.CertFile == "" || cfg.KeyFile == "" {
		return errors.New("probe requires a TLS certificate and key")
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("probe listen: %w", err)
	}
	defer ln.Close()
	server := &http.Server{Handler: &Bridge{Origin: cfg.Origin, LegacyOrigin: cfg.LegacyOrigin, Secret: key, Lookup: LookupTailscaleDevice}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
			return
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	err = server.ServeTLS(ln, cfg.CertFile, cfg.KeyFile)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
