# Architecture and lifecycle

## Connection model

The Agent initiates a signed WSS control connection to the Hub. Heartbeat inventories report node identity, platform, working-user home, and observed terminal state. The Hub never dials a private node address.

For each browser attachment, the Hub issues a 15-second one-time ticket. The Agent initiates a separate authenticated data WSS connection carrying that ticket. The Hub pairs the two sockets. Binary frames transport PTY bytes; text frames transport resize events and processed-output acknowledgments. The control socket is independent of noisy terminal output.

Each attachment launches `tmux attach-session` inside its own PTY. The actual shell belongs to a separate, per-terminal tmux server supervised by a separate systemd user unit. Disconnecting or upgrading the Agent destroys attachments but not session units.

## Ownership and size

The Hub tracks one controller per terminal. Other attachments use tmux readonly clients. The Agent explicitly applies canonical window dimensions only for the current controller; viewer PTY dimensions affect only their viewport. This also supports older tmux releases without latest/ignore-size behavior. Input is checked by the Hub and Agent. A readonly viewer can resize its own viewport without changing the running program's canonical dimensions. Takeover reserves ownership for the new attachment before disconnecting the old controller; the old browser reconnects readonly.

The browser sends cols/rows on layout changes; the Agent applies those to the attachment PTY. tmux relays appropriate size changes to its pane. The browser never queues/replays input across reconnections.

## Persistence and reconciliation

Hub SQLite stores administrator password hashes, hashed browser sessions, hashed enrollment tokens, node public keys, terminal metadata, desired state, and last observed state/time. It does not contain live process state, terminal keystrokes, or default output recordings.

Agent JSON records are atomically replaced and fsynced. A stable terminal ID is the idempotency key for node creation. A record is saved before process creation, so retrying a delayed request never starts a second shell. An interrupted creation may become `lost` rather than rerunning an unknown task.

- `creating`: request saved, actual node result not yet observed.
- `running`: live shell observed on the node.
- `exited`: shell exited; tmux retains its last screen.
- `closed`: explicit termination completed.
- `lost`: the recorded process no longer exists, for example after node reboot.
- `error`: creation failed.

Node connectivity is independent of terminal state. Offline observations are stale, not proof that a task ended. A durable `desired_state=closed` is reconciled when an offline Agent returns. The UI makes this deferred termination visible.

Terminating a terminal stops its dedicated systemd unit/cgroup, including ordinary background descendants. Processes deliberately moved into other services/cgroups are outside this lifecycle. Revoking a node disconnects management access but deliberately leaves its work running.

## Output and history

The running tmux server preserves the current screen and up to 10,000 history lines per pane in memory. Browser scrollback is per attachment. Reconnection attaches and redraws the current screen; it does not reconstruct all historical terminal output in the browser scrollback. tmux copy mode can inspect retained pane history.

Data uses a bounded output acknowledgment window (256 KiB plus one chunk). A slow attachment is disconnected after its timeout, freeing the task from a stalled browser. Full recording/export and task-specific completion detection are not implemented.

## Trust and authentication

The Hub is trusted with terminal data. HTTPS/WSS encrypt browser↔Hub and Agent↔Hub hops; this is not end-to-end encryption through an untrusted Hub.

Initial join uses a short-lived token that can enroll one node identity, with Ed25519 proof of key possession. The same key can retry a lost enrollment response during the token validity window; a different key cannot reuse it. Subsequent Agent handshakes sign method, request URI, timestamp, and nonce. Timestamp windows and a nonce cache reject replay. Nodes can be revoked independently.

Browser login uses bcrypt and server-side hashed sessions. Cookies are HttpOnly, SameSite=Strict, and Secure/\_\_Host-prefixed on HTTPS. Mutations require a session-bound CSRF header; browser WebSockets require the configured Origin. Logout/password changes revoke relevant sockets. Static assets are self-hosted; the Hub sends a restrictive CSP and frame denial.

This release is a single-administrator Linux workspace, not a multi-tenant command-execution sandbox. Terminal commands run with the enrolled OS user's existing filesystem and tool credentials. It does not synchronize or upload Codex/API credentials.

## Directory navigation

An authenticated directory request is routed through the selected node's signed control channel. The Agent reads immediate child directories as its OS user; file entries are excluded, hidden directories are optional, and symlink directories resolve to their actual target. Listing is bounded in entry count and duration. The browser can select children, navigate to the parent/home, or enter a path manually. Nodes advertise this capability so older Agents can fall back to manual entry until upgraded.

Directory access follows the enrolled user's existing permissions. It is not confined to the user's home, matching the terminal's filesystem access.
