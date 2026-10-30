# Operations

## Status and logs

```sh
# Public Hub
ssh root@server.example.com 'cd /opt/stacks/workdeck && docker compose ps'
ssh root@server.example.com 'docker logs --tail 100 workdeck-hub'
curl -fsS https://work.example.com/healthz

# Current machine's Agent
systemctl --user status workdeck-agent
journalctl --user -u workdeck-agent -n 100 --no-pager
systemctl --user list-units 'workdeck-session-*'
```

## Restart or upgrade

```sh
systemctl --user restart workdeck-agent
ssh root@server.example.com 'cd /opt/stacks/workdeck && docker compose restart hub'
```

Both operations temporarily detach browsers. tmux session units keep running. The Agent reconnects with exponential backoff and inventories existing terminal records. The browser retries without replaying keystrokes.

For a new release, commit the source, run `scripts/build.sh`, then `scripts/deploy.sh`. To upgrade the Agent, replace `~/.local/bin/workdeck` atomically with the correct architecture binary and restart only `workdeck-agent.service`. Never stop `workdeck-session-*` during an ordinary Agent upgrade.

## Backup and restore

The database uses WAL. Do not copy just `workdeck.db` while the Hub is writing it. Use SQLite's online backup API or briefly stop the Hub while copying the entire `data/` directory. Stopping the Hub does not stop node tasks.

```sh
ssh root@server.example.com '
  set -e
  cd /opt/stacks/workdeck
  docker compose stop hub
  trap "docker compose start hub" EXIT
  tar -czf "backups/data-$(date +%Y%m%d-%H%M%S).tar.gz" data
'
```

Back up each node's private `~/.local/share/workdeck` directory separately. Its identity authenticates that node; restrict access accordingly. Metadata backup does not checkpoint running operating-system processes. Restoring node records after reboot will show unavailable sessions as lost; it will not rerun commands.

## Terminate and disconnect

Closing a UI tab only detaches a view. The terminal remains listed in the overview. The explicit terminate action stops the terminal's dedicated systemd unit. If the node is offline, the desired termination is saved and executed when it returns. The UI labels this pending state.

To recover a surviving session manually:

```sh
tmux -L workdeck-TERMINAL_ID attach-session -t main
```

To stop a particular Workdeck terminal manually:

```sh
systemctl --user stop workdeck-session-TERMINAL_ID.service
```

Revoking a node disables further access and disconnects its sockets; it does not terminate local tasks. To reuse a revoked machine, preserve its old records as needed and enroll a new identity in a different data directory, or carefully archive the old identity before reenrolling. Do not delete data directories containing needed session records.

## Release limits

Linux with systemd user services only; one administrator; one Hub. No full terminal recording/export, file manager, native Windows Agent, task checkpointing, or high availability. tmux retains its screen/history in memory, and the UI keeps metadata on disk. Terminal survival across node power loss is not supported.
