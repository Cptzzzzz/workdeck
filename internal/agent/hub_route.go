package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type hubRouteHint struct {
	Hub  string `json:"hub"`
	Host string `json:"host"`
}

func validTailnetHost(host string) bool {
	if len(host) > 253 || !strings.HasSuffix(host, ".ts.net") {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 4 {
		return false
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-' {
				return false
			}
		}
	}
	return true
}

func (a *Agent) loadHubRouteHint() {
	f, err := os.Open(filepath.Join(a.sessions.dir, "hub-route.json"))
	if err != nil {
		return
	}
	defer f.Close()
	var hint hubRouteHint
	if json.NewDecoder(io.LimitReader(f, 4096)).Decode(&hint) == nil && hint.Hub == a.identity.Hub && validTailnetHost(hint.Host) {
		a.tailnetHost = hint.Host
	}
}

func (a *Agent) updateHubRouteHint(host string) {
	host = strings.ToLower(host)
	if !validTailnetHost(host) {
		host = ""
	}
	a.routeMu.Lock()
	if a.tailnetHost == host {
		a.routeMu.Unlock()
		return
	}
	a.tailnetHost = host
	a.routeMu.Unlock()
	// An empty hint revokes the persisted alternative as well. Failure to write
	// is nonfatal: the in-memory choice still updates and public dialing works.
	// Persist off the control reader so slow disk sync cannot delay attachments.
	go func() {
		a.routePersistMu.Lock()
		defer a.routePersistMu.Unlock()
		a.routeMu.RLock()
		latest := a.tailnetHost
		a.routeMu.RUnlock()
		_ = atomicJSON(filepath.Join(a.sessions.dir, "hub-route.json"), hubRouteHint{Hub: a.identity.Hub, Host: latest})
	}()
}

var tailnetIPv4 = netip.MustParsePrefix("100.64.0.0/10")
var tailnetIPv6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

func tailnetAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return tailnetIPv4.Contains(ip) || tailnetIPv6.Contains(ip)
}

func hasTailnetInterface() bool {
	interfaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range interfaces {
		if !tailnetInterface(iface.Name) || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, value := range addrs {
			prefix, err := netip.ParsePrefix(value.String())
			if err == nil && tailnetAddress(prefix.Addr()) {
				return true
			}
		}
	}
	return false
}

type hubDialResult struct {
	conn net.Conn
	err  error
}

// Race transport establishment only. The signed WebSocket request and its
// single-use ticket are sent once, after a winner has been selected.
func raceHubDials(ctx context.Context, public, tailnet func(context.Context) (net.Conn, error)) (net.Conn, error) {
	raceCtx, cancel := context.WithCancel(ctx)
	results := make(chan hubDialResult, 2)
	for _, dial := range []func(context.Context) (net.Conn, error){public, tailnet} {
		go func(dial func(context.Context) (net.Conn, error)) {
			c, err := dial(raceCtx)
			results <- hubDialResult{c, err}
		}(dial)
	}
	remaining := 2
	var errs []error
	drain := func(n int) {
		for ; n > 0; n-- {
			if r := <-results; r.conn != nil {
				_ = r.conn.Close()
			}
		}
	}
	for remaining > 0 {
		select {
		case r := <-results:
			remaining--
			if r.err == nil && r.conn != nil {
				cancel()
				if remaining > 0 {
					go drain(remaining)
				}
				return r.conn, nil
			}
			if r.conn != nil {
				_ = r.conn.Close()
			}
			if r.err != nil {
				errs = append(errs, r.err)
			}
		case <-ctx.Done():
			cancel()
			go drain(remaining)
			return nil, ctx.Err()
		}
	}
	cancel()
	if len(errs) == 0 {
		return nil, errors.New("both Hub connections failed")
	}
	return nil, errors.Join(errs...)
}

func (a *Agent) dialHubTCP(ctx context.Context, network, address string) (net.Conn, error) {
	return a.dialHub(ctx, network, address, "")
}

func (a *Agent) dialHubTLS(ctx context.Context, network, address string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	return a.dialHub(ctx, network, address, host)
}

func (a *Agent) dialHub(ctx context.Context, network, address, tlsName string) (net.Conn, error) {
	dialer := &net.Dialer{}
	connect := func(ctx context.Context, target string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, target)
		if err != nil || tlsName == "" {
			return conn, err
		}
		// Each path must finish TLS authentication before it can win. A
		// reachable but misconfigured alternate must not suppress the public one.
		secure := tls.Client(conn, &tls.Config{ServerName: tlsName, MinVersion: tls.VersionTLS12})
		if err := secure.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return secure, nil
	}
	a.routeMu.RLock()
	host := a.tailnetHost
	a.routeMu.RUnlock()
	if host == "" || !hasTailnetInterface() {
		return connect(ctx, address)
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	public := func(ctx context.Context) (net.Conn, error) { return connect(ctx, address) }
	tailnet := func(ctx context.Context) (net.Conn, error) {
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		// Prefer IPv4 when both are available; either family remains eligible.
		sort.SliceStable(ips, func(i, j int) bool { return ips[i].Is4() && !ips[j].Is4() })
		var errs []error
		for _, ip := range ips {
			if !tailnetAddress(ip) {
				continue
			}
			attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
			conn, e := connect(attempt, net.JoinHostPort(ip.String(), port))
			cancel()
			if e == nil {
				return conn, nil
			}
			errs = append(errs, e)
		}
		if len(errs) == 0 {
			return nil, errors.New("no Tailnet address")
		}
		return nil, errors.Join(errs...)
	}
	return raceHubDials(ctx, public, tailnet)
}
