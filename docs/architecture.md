# Architecture and lifecycle

## Connection model

The Agent initiates a signed WSS control connection to the Hub. Heartbeat inventories report node identity, platform, working-user home, and observed terminal state. The Hub never dials a private node address.

For each browser attachment, the Hub issues a 15-second one-time ticket. The Agent initiates a separate authenticated data WSS connection carrying that ticket. The Hub pairs the two sockets. Binary frames transport PTY bytes; text frames transport resize events and processed-output acknowledgments. The control socket is independent of noisy terminal output.

The relay is immediately usable. New browsers and Agents optionally negotiate a reliable, ordered WebRTC DataChannel over that same authenticated attachment. Six paired, small end-to-end probes compare relay/direct median RTT, tail latency, and failures. A materially faster direct path wins; nearly equivalent paths prefer direct to save relay bandwidth. A slower or inconsistent direct path leaves terminal traffic on the relay. This is an interactive-latency heuristic, not a throughput benchmark or a guarantee of a globally optimal route.

The browser repeats route comparisons approximately once a minute while visible. Lightweight end-to-end probes refresh the relay and any open direct channel every five seconds, including the currently unused candidate. Hysteresis and a minimum switch interval prevent small fluctuations from continually changing routes. Failed direct attempts have a two-minute browser cooldown; unsupported browsers and older Agents keep using the original relay. Returning a backgrounded page to the foreground requests another comparison when a peer is available.

The terminal network strip displays both paths' RTT and the committed active route. Its expandable panel shows rolling median RTT over at most twelve probes, mean absolute changes between adjacent valid RTTs as jitter, and probe timeout counts. Timeouts are not interpreted as IP packet loss. Measurement timestamps distinguish stale/unknown values from a measured zero. Terminal payload bytes are counted separately for each path and direction; one-second byte deltas use actual monotonic elapsed time for transfer rates. Counters describe this browser attachment only, exclude signaling/probe/framing traffic, and are not a measurement of link capacity or the host network interface.

Path changes preserve the same PTY. The Agent fences output on the old ordered channel, pauses output, and waits for a matching commit on the target channel before resuming. The browser buffers a bounded amount of input only during this live handshake; it never replays unconfirmed input after a connection failure. A broken direct connection reattaches through the relay and redraws the existing tmux session. Backpressure and controller/readonly rules apply to both transports.

The browser↔Hub and Agent↔Hub WebSockets remain open as the authorization lease and signaling path. Logout, node revocation, terminal closure, Hub/Agent reconnection, or takeover closes the corresponding direct attachment too. The Agent independently checks the current per-terminal controller ticket for direct input and canonical resizing. No TURN service is required: direct candidates are attempted, and WebSocket remains the fallback. No stable inbound terminal port or manual router mapping is required; successful direct traffic requires suitable UDP/NAT/firewall conditions.

The creating service account is recorded with each terminal; root Agents can retain access to migrated sessions owned by an earlier account. Each attachment launches `tmux attach-session` inside its own PTY. The actual shell belongs to a separate, per-terminal tmux server supervised by a separate systemd unit (system scope for root, user scope for ordinary accounts). Disconnecting or upgrading the Agent destroys attachments but not session units.

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

The Hub remains trusted for authentication, signaling, and serving browser code. HTTPS/WSS encrypt the relayed hops. Selected direct terminal data travels over WebRTC DTLS without being relayed by the Hub, but this does not provide protection against a malicious Hub supplying browser code or signaling. ICE/SDP may reveal endpoint addresses and is not stored in the database or ordinary logs.

Initial join uses a short-lived token that can enroll one node identity, with Ed25519 proof of key possession. The same key can retry a lost enrollment response during the token validity window; a different key cannot reuse it. Subsequent Agent handshakes sign method, request URI, timestamp, and nonce. Timestamp windows and a nonce cache reject replay. Nodes can be revoked independently.

New passwords use salted PBKDF2-HMAC-SHA256 (600,000 iterations) and retain compatibility with existing bcrypt hashes. New passwords require at least six characters containing both letters and digits, without an uppercase/lowercase requirement or a password-specific maximum length. Browser login uses server-side hashed sessions. Cookies are HttpOnly, SameSite=Strict, and Secure/\_\_Host-prefixed on HTTPS. Mutations require a session-bound CSRF header; browser WebSockets require the configured Origin. Logout/password changes revoke relevant sockets. Static assets are self-hosted; the Hub sends a restrictive CSP and frame denial.

This release is a single-administrator Linux workspace, not a multi-tenant command-execution sandbox. Terminal commands run with the enrolled OS user's existing filesystem and tool credentials. It does not synchronize or upload Codex/API credentials.

## Directory navigation

An authenticated directory request is routed through the selected node's signed control channel. The Agent reads immediate child directories as its OS user; file entries are excluded, hidden directories are optional, and symlink directories resolve to their actual target. Listing is bounded in entry count and duration. The browser can select children, navigate to the parent/home, or enter a path manually. Nodes advertise this capability so older Agents can fall back to manual entry until upgraded.

Directory access follows the enrolled user's existing permissions. It is not confined to the user's home, matching the terminal's filesystem access.
