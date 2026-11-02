package agent

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRaceHubDialsUsesFirstAvailableAndCancelsOther(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()
	cancelled := make(chan struct{})
	public := func(ctx context.Context) (net.Conn, error) { <-ctx.Done(); close(cancelled); return nil, ctx.Err() }
	tailnet := func(context.Context) (net.Conn, error) { return client, nil }
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := raceHubDials(ctx, public, tailnet)
	if err != nil || got != client {
		t.Fatalf("alternative not selected: %v", err)
	}
	defer got.Close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("losing dial was not canceled")
	}
}

func TestHubTailnetLiveTLSFallback(t *testing.T) {
	host, publicName := os.Getenv("WORKDECK_TEST_TAILNET_HOST"), os.Getenv("WORKDECK_TEST_PUBLIC_HOST")
	if host == "" || publicName == "" {
		t.Skip("requires an explicitly configured Tailnet integration test")
	}
	a := &Agent{tailnetHost: host}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	// The local port is intentionally closed, so success requires the Tailnet
	// path. TLS still verifies the original public Hub hostname.
	conn, err := a.dialHub(ctx, "tcp", "127.0.0.1:443", publicName)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, ok := conn.(*tls.Conn); !ok {
		t.Fatal("alternate connection did not authenticate TLS")
	}
	if _, err := fmt.Fprintf(conn, "GET /healthz HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", publicName); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected health status: %d", response.StatusCode)
	}
}

func TestRaceHubDialsFallsBackAndHonorsCancellation(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()
	public := func(context.Context) (net.Conn, error) { return client, nil }
	tailnet := func(context.Context) (net.Conn, error) { return nil, errors.New("unavailable") }
	got, err := raceHubDials(context.Background(), public, tailnet)
	if err != nil || got != client {
		t.Fatalf("public fallback failed: %v", err)
	}
	got.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	wait := func(ctx context.Context) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
	if _, err = raceHubDials(ctx, wait, wait); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestRaceHubDialsClosesLateSuccessfulLoser(t *testing.T) {
	winner, winnerPeer := net.Pipe()
	defer winnerPeer.Close()
	loser, loserPeer := net.Pipe()
	defer loserPeer.Close()
	public := func(context.Context) (net.Conn, error) { return winner, nil }
	tailnet := func(ctx context.Context) (net.Conn, error) { <-ctx.Done(); return loser, nil }
	got, err := raceHubDials(context.Background(), public, tailnet)
	if err != nil {
		t.Fatal(err)
	}
	defer got.Close()
	_ = loserPeer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = loserPeer.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("losing socket not closed: %v", err)
	}
}

func TestHubTailnetHintIsValidatedAndBoundToHub(t *testing.T) {
	for _, host := range []string{"", "ts.net", "machine.ts.net", "bad_name.tail.ts.net", "node.tail.ts.net.evil", "-node.tail.ts.net", "node..ts.net"} {
		if validTailnetHost(host) {
			t.Fatalf("invalid hostname accepted: %q", host)
		}
	}
	if !validTailnetHost("node.tailnet.ts.net") {
		t.Fatal("valid hostname rejected")
	}
	dir := t.TempDir()
	a := &Agent{identity: Identity{Hub: "https://hub.example"}, sessions: &Sessions{dir: dir}}
	a.updateHubRouteHint("NODE.TAILNET.TS.NET")
	b := &Agent{identity: a.identity, sessions: &Sessions{dir: dir}}
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		b.loadHubRouteHint()
		if b.tailnetHost != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if b.tailnetHost != "node.tailnet.ts.net" {
		t.Fatal("valid hint not restored")
	}
	c := &Agent{identity: Identity{Hub: "https://other.example"}, sessions: &Sessions{dir: dir}}
	c.loadHubRouteHint()
	if c.tailnetHost != "" {
		t.Fatal("hint reused for another Hub")
	}
	a.updateHubRouteHint("bad_name.tail.ts.net")
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		data, err := os.ReadFile(filepath.Join(dir, "hub-route.json"))
		if err == nil && strings.Contains(string(data), `"host": ""`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, err := os.ReadFile(filepath.Join(dir, "hub-route.json"))
	if err != nil || !strings.Contains(string(data), `"host": ""`) {
		t.Fatal("revoked hint survived restart")
	}
}
