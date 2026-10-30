# Deploying behind an existing Caddy stack

Keep actual infrastructure values in `.env.deploy.local`, which is ignored by Git. The repository contains only `.env.deploy.example` placeholders. Copy and edit that file before deployment:

```sh
cp .env.deploy.example .env.deploy.local
chmod 600 .env.deploy.local
```

The private file specifies the SSH target, public HTTPS URL, server deployment directory, existing Docker network, Caddy directory/container, and optional trusted proxy CIDR. The deploy script sources this file as trusted shell code; do not source a configuration received from an untrusted source.

The deployment host needs Docker Compose, an existing Caddy container, and an existing Docker network shared with Caddy. The Caddy configuration directory must be mounted at `/etc/caddy` inside its container. The SSH account needs permission to manage these resources. Current release images target Linux amd64 servers; Agents are available for amd64 and arm64.

```sh
scripts/build.sh
scripts/deploy.sh
```

The script creates an isolated Workdeck Compose stack and attaches it to the configured network. It exposes no additional host port. If the hostname is not already configured, it appends a Caddy site, validates the complete candidate, saves a backup, and reloads Caddy. Existing application containers are not recreated. Existing site blocks are left for the operator to manage.

## Server layout

Example root: `/opt/stacks/workdeck` (configurable).

```text
compose.yml                 service definition
.env                        deployed version and runtime configuration
build/                      release build context
data/workdeck.db           SQLite database, UID 65532
secrets/admin_password      initial password, mode 0400, UID 65532
backups/                    private ingress/version backups
```

The Hub runs as UID/GID 65532 with a read-only root filesystem, dropped capabilities, no-new-privileges, and bounded memory/logs. Its writable bind mount contains SQLite. Administrator secrets are transferred separately, outside images and source archives.

The initial username is `admin`. Before first deployment, place a password of at least six characters containing both letters and digits in local `.secrets/administrator.txt` with mode 0600 and parent directory mode 0700. After a UI password change, the database password hash is authoritative; the initialization file no longer reflects the active password.

## Agent service

The installer uses the account that creates the service: root installs a system service, while other users install a user service. New terminals inherit that account:

- Executable: `~/.local/bin/workdeck`.
- Private identity and session records: `~/.local/share/workdeck/`.
- Ordinary account unit: `~/.config/systemd/user/workdeck-agent.service`.
- Root account unit: `/etc/systemd/system/workdeck-agent.service`.
- Per-terminal units: `workdeck-session-<terminal-id>.service`.

Unrelated terminal services are outside Workdeck's management. See [node onboarding](agent-setup.md), [operations](operations.md), and [sensitive data](security.md).
