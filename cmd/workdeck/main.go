package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workdeck/internal/agent"
	"workdeck/internal/fileworker"
	"workdeck/internal/hub"
	"workdeck/internal/tailprobe"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: workdeck hub | agent enroll | agent run | version")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch os.Args[1] {
	case "managed-codex":
		f := flag.NewFlagSet("managed-codex", flag.ContinueOnError)
		dir := f.String("data-dir", "", "node data directory")
		id := f.String("terminal-id", "", "terminal identifier")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		return agent.ManagedCodex(*dir, *id)
	case "codex-hook":
		f := flag.NewFlagSet("codex-hook", flag.ContinueOnError)
		dir := f.String("data-dir", "", "node data directory")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		_ = agent.HandleCodexHook(*dir, os.Stdin)
		fmt.Println("{}")
		return nil
	case "codex-hooks":
		f := flag.NewFlagSet("codex-hooks", flag.ContinueOnError)
		dir := f.String("data-dir", "", "node data directory")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		return agent.InstallCodexHooks(*dir)
	case "tracked-codex", "codex-event":
		f := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
		dir := f.String("data-dir", "", "node data directory")
		id := f.String("terminal-id", "", "terminal identifier")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		if os.Args[1] == "tracked-codex" {
			return agent.CodexLaunch(*dir, *id, f.Args())
		}
		if f.NArg() != 1 {
			return fmt.Errorf("invalid notification")
		}
		return agent.CodexEvent(*dir, *id, f.Arg(0))
	case "file-worker":
		f := flag.NewFlagSet("file-worker", flag.ContinueOnError)
		dir := f.String("data-dir", "", "private file worker state directory")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		if *dir == "" || !filepath.IsAbs(*dir) {
			return fmt.Errorf("file-worker requires an absolute --data-dir")
		}
		go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
		return fileworker.Run(ctx, *dir, os.Stdin, os.Stdout)
	case "tailnet-probe":
		f := flag.NewFlagSet("tailnet-probe", flag.ContinueOnError)
		cfg := tailprobe.Config{}
		f.StringVar(&cfg.Addr, "addr", "", "Tailscale IP and port to listen on")
		f.StringVar(&cfg.Origin, "origin", "", "public Workdeck HTTPS origin")
		f.StringVar(&cfg.LegacyOrigin, "legacy-origin", "", "temporary prior Workdeck HTTPS origin")
		f.StringVar(&cfg.SecretFile, "secret-file", "", "shared probe secret file")
		f.StringVar(&cfg.CertFile, "tls-cert-file", "", "TLS certificate file")
		f.StringVar(&cfg.KeyFile, "tls-key-file", "", "TLS key file")
		if err := f.Parse(os.Args[2:]); err != nil {
			return err
		}
		return tailprobe.Run(ctx, cfg)
	case "version":
		fmt.Println(version)
		return nil
	case "hub":
		f := flag.NewFlagSet("hub", flag.ExitOnError)
		cfg := hub.Config{}
		f.StringVar(&cfg.Addr, "addr", ":8090", "listen address")
		f.StringVar(&cfg.PublicURL, "public-url", "", "external HTTPS URL")
		f.StringVar(&cfg.LegacyOrigin, "legacy-origin", "", "temporary prior HTTPS origin for browser migration")
		f.StringVar(&cfg.DataDir, "data-dir", "./data", "persistent data directory")
		f.StringVar(&cfg.AssetsDir, "assets-dir", "./web/dist", "built frontend directory")
		f.StringVar(&cfg.AdminUser, "admin-user", "admin", "initial administrator username")
		f.StringVar(&cfg.PasswordFile, "admin-password-file", "", "initial administrator password file")
		f.StringVar(&cfg.TrustedProxyCIDR, "trusted-proxy-cidr", "", "trusted reverse proxy network, for login rate limiting")
		f.StringVar(&cfg.TailnetProbeURL, "tailnet-probe-url", "", "optional HTTPS Tailnet probe URL")
		f.StringVar(&cfg.TailnetProbeSecretFile, "tailnet-probe-secret-file", "", "shared secret file for Tailnet probe")
		f.DurationVar(&cfg.SessionTTL, "session-ttl", 30*24*time.Hour, "persistent browser login lifetime, renewed while active")
		_ = f.Parse(os.Args[2:])
		h, err := hub.New(cfg)
		if err != nil {
			return err
		}
		return h.Run(ctx)
	case "agent":
		if len(os.Args) < 3 {
			return fmt.Errorf("usage: workdeck agent enroll | run")
		}
		home, _ := os.UserHomeDir()
		f := flag.NewFlagSet("agent "+os.Args[2], flag.ExitOnError)
		dir := f.String("data-dir", filepath.Join(home, ".local", "share", "workdeck"), "private agent data directory")
		hubURL := f.String("hub", "", "Hub URL")
		name := f.String("name", "", "node display name")
		token := f.String("token", "", "one-time enrollment token")
		tokenFile := f.String("token-file", "", "read enrollment token from a file")
		_ = f.Parse(os.Args[3:])
		switch os.Args[2] {
		case "enroll":
			if *tokenFile != "" {
				b, e := os.ReadFile(*tokenFile)
				if e != nil {
					return e
				}
				*token = strings.TrimSpace(string(b))
			}
			if *name == "" {
				*name, _ = os.Hostname()
			}
			if err := agent.Enroll(*dir, *hubURL, *name, *token); err != nil {
				return err
			}
			fmt.Println("Node enrolled. Start with: workdeck agent run")
			return nil
		case "run":
			a, err := agent.New(*dir, version)
			if err != nil {
				return err
			}
			return a.Run(ctx)
		}
	}
	return fmt.Errorf("unknown command")
}
