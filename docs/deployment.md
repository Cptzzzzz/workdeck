# Deployment on server.example.com

## Existing infrastructure

Inspected on 2026-10-30:

- Existing Compose stack: `/opt/stacks/public-apps/compose.yml`.
- Caddy configuration: `/opt/stacks/public-apps/caddy/Caddyfile`.
- Existing ingress container: `caddy`, exposing 80/443.
- Existing Docker network: `public-apps_default`.
- `work.example.com` resolves to `server.example.com`.

Workdeck uses the same deployment pattern, with an isolated stack at `/opt/stacks/workdeck`. Its Compose service joins the existing network. No additional host port is exposed. The only change to the existing stack is an appended `work.example.com` site in Caddy; the complete candidate is validated before reload, with a backup saved first. Existing application containers are not recreated.

## Server paths

```text
/opt/stacks/workdeck/
  compose.yml                  service definition
  .env                         deployed image version
  build/                       release build context
  data/workdeck.db              SQLite database (UID 65532)
  secrets/admin_password       initial password (0400, UID 65532)
  backups/                    ingress/version backups
```

The Hub runs as UID/GID 65532 with a read-only root filesystem, dropped capabilities, no-new-privileges, and bounded memory/logs. Its writable bind mount contains the SQLite database. A restart does not erase the database.

The administrator username is `admin`. The initial password is in the local ignored file `.secrets/administrator.txt`; change it in the UI after first login. After a UI password change, the initial file is no longer authoritative: the database password hash is authoritative. The password file is read only when initializing an empty database.

## First node

The current development host `worker-01` is the first production node. The Agent runs as user `fuxc`:

- Executable: `~/.local/bin/workdeck`.
- Identity and session records: `~/.local/share/workdeck/`.
- User unit: `~/.config/systemd/user/workdeck-agent.service`.
- Per-terminal units: `workdeck-session-<terminal-id>.service`.

The existing `agent-terminal.service` and `agent-terminal-tmux.service` use their own executable/configuration/socket and are not managed by Workdeck.

The Agent identity and the initial administrator password are never committed to Git or embedded in container images.
