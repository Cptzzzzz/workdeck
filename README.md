# Workdeck

A self-hosted browser workspace for persistent terminals on outbound-only Linux machines.

- **Hub:** Go, SQLite, authenticated browser API, node registry, reverse WebSocket relay.
- **Agent:** an unprivileged Linux user service, Ed25519 node identity, outbound HTTPS/WSS only.
- **Terminal:** xterm.js + PTY + one independent tmux/systemd unit per terminal.
- **Web:** React/TypeScript, desktop/mobile layout, one controller plus readonly viewers, explicit takeover.

Closing a browser tab or restarting the Hub/Agent does not terminate the actual terminal. A node reboot destroys its live processes; metadata survives and marks those sessions lost. No automatic task replay is performed.

## Local development

Requires Go 1.25+, Node 22+, tmux, and a working systemd user manager for the Agent. The host user should have lingering enabled if terminals must survive logout.

```sh
mkdir -p .secrets
chmod 700 .secrets
# Put a random 16–72 byte initial password in this file (never commit it):
openssl rand -base64 30 > .secrets/administrator.txt
chmod 600 .secrets/administrator.txt
npm ci --prefix web
npm run build --prefix web
go build -o bin/workdeck ./cmd/workdeck
bin/workdeck hub --addr 127.0.0.1:8090 \
  --public-url http://127.0.0.1:8090 --data-dir .secrets/local-hub \
  --admin-password-file .secrets/administrator.txt
```

Visit the same URL used by `--public-url`; login with username `admin`. Generate an enrollment token in the UI. For development only, use the CLI to enroll against localhost HTTP:

```sh
bin/workdeck agent enroll --hub http://127.0.0.1:8090 --name my-machine --token TOKEN
bin/workdeck agent run
```

An Agent identity is stored by default in `~/.local/share/workdeck/identity.json` with mode 0600. Enroll once; subsequent starts use the signed node identity. In production, use the UI-generated Linux installer to configure the user service.

## Build and deploy

```sh
scripts/build.sh
scripts/deploy.sh
```

`build.sh` cross-compiles Linux amd64/arm64 executables, prepares downloadable Agents/checksums, and builds the frontend. `deploy.sh` uses SSH to the existing server, creates the isolated `/opt/stacks/workdeck` Compose stack, joins the existing Caddy network, validates the appended hostname configuration, and reloads Caddy. Administrator secrets are transferred separately, outside images and Git. See [deployment notes](docs/deployment.md).

## Verification

```sh
go test -race ./...
go vet ./...
npm run build --prefix web
cd web
# Override CHROMIUM_PATH if a browser is not installed at the development host path.
CHROMIUM_PATH=/path/to/chromium npx playwright test
```

The browser acceptance test requires a running Hub and exactly one connected test node. It creates and terminates its own terminal; it does not touch pre-existing sessions. Set `WORKDECK_TEST_URL` and `WORKDECK_TEST_PASSWORD_FILE` for a different environment.

Read [architecture](docs/architecture.md), [operations](docs/operations.md), and [deployment](docs/deployment.md) for lifecycle rules and recovery procedures.
