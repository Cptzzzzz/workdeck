# Operations

The examples below use placeholders. Substitute your private deployment values; do not commit them.

## Status and logs

```sh
ssh deploy@server.example.com 'cd /opt/stacks/workdeck && docker compose ps'
ssh deploy@server.example.com 'docker logs --tail 100 workdeck-hub'
curl -fsS https://work.example.com/healthz

systemctl --user status workdeck-agent
journalctl --user -u workdeck-agent -n 100 --no-pager
systemctl --user list-units 'workdeck-session-*'
```

On hosts restricting journal access, consult the system administrator rather than publishing complete logs. Logs, screenshots, and terminal output may contain private task information.

## Restart or upgrade

```sh
systemctl --user restart workdeck-agent
ssh deploy@server.example.com 'cd /opt/stacks/workdeck && docker compose restart hub'
```

Both operations temporarily detach browsers. tmux session units keep running. The Agent reconnects with exponential backoff and inventories existing records. Browsers retry without replaying keystrokes.

For a new release, commit the source, run `scripts/build.sh`, then `scripts/deploy.sh` with your ignored local configuration. Upgrade an Agent by replacing `~/.local/bin/workdeck` atomically with the correct architecture binary, then restarting only `workdeck-agent.service`. Do not stop session units during routine Agent upgrades.

## Backup and restore

SQLite uses WAL. Use its online backup API or briefly stop the Hub before copying the entire `data/` directory; copying only `workdeck.db` during writes is unsafe. Stopping the Hub does not stop node tasks.

```sh
ssh deploy@server.example.com '
  set -e
  cd /opt/stacks/workdeck
  docker compose stop hub
  trap "docker compose start hub" EXIT
  tar -czf "backups/data-$(date +%Y%m%d-%H%M%S).tar.gz" data
'
```

Back up each node's private `~/.local/share/workdeck` separately. Protect its identity as a login credential. Metadata backups do not checkpoint operating-system processes; restoring records after reboot marks unavailable sessions lost and does not replay commands.

## Terminate and disconnect

Closing a UI tab detaches only that view. Explicit termination stops the terminal's dedicated systemd unit and ordinary background descendants. If the node is offline, termination is saved and reconciled when it returns. The UI labels the pending state.

Recover a surviving session manually:

```sh
tmux -L workdeck-TERMINAL_ID attach-session -t main
```

Stop a specific Workdeck terminal manually:

```sh
systemctl --user stop workdeck-session-TERMINAL_ID.service
```

Revoking a node disables its identity and disconnects management access, while leaving local tasks running. Reenroll with a new identity only after preserving needed records. Reenrollment under a new node ID does not automatically migrate old terminal ownership.

## Release limits

Linux with systemd user services; one administrator; one Hub. No full output recording/export, native Windows Agent, process checkpointing, or high availability. tmux screen/history lives in memory; metadata lives on disk. Node power loss destroys running terminal processes.

## Reboot recovery and inventory reconciliation

Hub node records, terminal metadata, and browser sessions are stored on the persistent data volume. A Hub restart loads them before Agents reconnect. Nodes initially appear offline with their last observed terminal state; the next Agent inventory refreshes actual state. Complete inventories also mark previously running sessions missing from the node as lost. An incomplete inventory never treats omitted records as lost.

Agent identities and per-terminal records persist on disk. State changes discovered by the Agent are saved atomically. A node boot identifier distinguishes a node reboot from a network reconnection. The Agent and Hub services can start automatically after boot when Docker and the user's lingering systemd manager are enabled.

A Hub or Agent service restart preserves independently supervised terminal processes. A host OS reboot ends its processes: Workdeck retains the terminal records and synchronizes them to `lost`, with an explicit recreate action in the UI. Recreate opens a new Shell in the recorded directory and preserves the old record; it does not rerun the old commands or restore an application's in-memory state.

## Persistent browser sessions

Each device receives an independent HttpOnly persistent cookie and server-side session record. Default lifetime is 30 days, renewed during active authenticated use. The Hub flag `--session-ttl` accepts a lifetime such as `720h`; Compose exposes this as `WORKDECK_SESSION_TTL`. Closing a normal browser and reopening the same profile retains login. Private browsing, clearing cookies, expiration, or explicit logout requires another login.

Logging into another device does not revoke existing devices. Logout affects the current device only. Changing the password intentionally revokes the other sessions. Cookies remain protected by Secure and SameSite=Strict in HTTPS deployments; no login token is stored in JavaScript localStorage.

## Service accounts and root Agents

The account creating an Agent service determines the OS user of new terminals. Ordinary accounts use user units; root installs `/etc/systemd/system/workdeck-agent.service` with `User=root` and creates per-terminal system units. Root operations use `systemctl` without `--user`; ordinary-user operations retain `systemctl --user` and lingering.

Session metadata records its original account and service scope. During an account migration, preserve these fields, the Agent identity, and all session records. A root Agent can attach to old ordinary-user sessions and stop their original user units without recreating the processes. Do not disable the original user's lingering manager until all of those old sessions have finished. New terminals run as the new service account.

## Node names and password policy

Select a node in the sidebar and use the rename button in its details. Renaming updates only the display name, works while the node is offline, and persists through restarts without changing identity or terminal ownership.

New initial passwords and password changes require at least six Unicode characters and must contain an ASCII letter and an ASCII digit. Letter case is unrestricted; there is no password-specific upper length limit. Login remains compatible with existing passwords, including older values that predate this policy. New passwords use salted PBKDF2-HMAC-SHA256 (600,000 iterations); old bcrypt hashes remain readable. Existing account passwords are not changed by deployment. The normal HTTP request-body size limit applies to all JSON requests.

When promoting an Agent from an ordinary account to root, rotate its node signing key into root-only storage while preserving the node ID. The former ordinary account's key must no longer authenticate the root Agent identity. Keep private backups of identity, records, and the database before migration.

Versions predating the versioned PBKDF2 reader cannot authenticate passwords saved in the new hash format. Keep a matching database backup when rolling back across that change.
