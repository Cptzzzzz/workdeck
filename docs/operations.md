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
