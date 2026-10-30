# Workdeck

A self-hosted browser workspace for persistent terminals on outbound-only Linux machines.

- **Hub:** Go, SQLite, authenticated browser API, node registry, reverse WebSocket relay.
- **Agent:** a Linux system/user service selected by its installation account, Ed25519 node identity, outbound HTTPS/WSS only.
- **Terminal:** xterm.js + PTY + one independent tmux/systemd unit per terminal.
- **Web:** React/TypeScript, desktop/mobile layout, node directory chooser, one controller plus readonly viewers, explicit takeover.
- **Recovery:** durable node/terminal records, full-inventory reconciliation, and independent persistent device logins.
- **Compute:** the Hub host can enroll an ordinary-user Agent just like any other machine.

Closing a browser tab or restarting the Hub/Agent does not terminate the actual terminal. A node reboot destroys its live processes; metadata survives and marks those sessions lost. No automatic task replay is performed.

## Local development

Requires Go 1.25+, Node 22+, tmux, and systemd (a user manager for ordinary accounts, or the system manager for root). The host user should have lingering enabled if terminals must survive logout.

```sh
mkdir -p .secrets
chmod 700 .secrets
# Put an initial password (6+ characters, letters and digits, any letter case) in this file (never commit it):
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
cp .env.deploy.example .env.deploy.local
# Edit the private local file for your server, hostname, Caddy path, and Docker network.
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
npx playwright install chromium
npx playwright test
# Optional: CHROMIUM_PATH=/path/to/chromium npx playwright test
```

The browser acceptance tests require a running Hub and at least one connected test node. Set `WORKDECK_TEST_NODE_NAME` to select a particular node. It creates and terminates its own terminal; it does not touch pre-existing sessions. Set `WORKDECK_TEST_URL` and `WORKDECK_TEST_PASSWORD_FILE` for a different environment.

Read [architecture](docs/architecture.md), [operations](docs/operations.md), and [deployment](docs/deployment.md) for lifecycle rules and recovery procedures.

## Node onboarding and sensitive data

See [从节点接入指南](docs/agent-setup.md) and [敏感信息清单](docs/security.md). Public deployment examples use placeholder hostnames. Keep your actual infrastructure in ignored `.env.deploy.local`; credentials, Agent identities, databases, terminal output, and private Git backups must never be committed.
