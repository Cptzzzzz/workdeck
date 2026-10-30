# Acceptance record — 2026-10-30

Environment: a real HTTPS Hub with a Linux arm64 Agent, tmux 3.2a, desktop Chromium, and a 390 px mobile viewport. Host addresses, usernames, private paths, and original deployment identifiers are omitted from the public record.

Passed checks:

- Go tests with the race detector: administrator authentication, CSRF and Origin rejection, enrollment proof verification, idempotent enrollment response recovery, rejection of token reuse by another key, signed-handshake replay rejection, and password-change session revocation.
- `go vet ./...`, frontend TypeScript/production build, shell syntax checks.
- Go vulnerability scan: no affected symbols/packages imported by this application. npm production dependency audit: no vulnerabilities reported.
- Public HTTPS and `/healthz`; the real Linux installer downloaded a checksummed arm64 Agent, enrolled it, and enabled its user service.
- Browser terminal creation, real Shell input/output, browser refresh preserving an environment variable, and a background task completing while detached.
- A 54 KB Chinese clipboard paste delivered intact through multiple input frames, tested in a clean Bash session to isolate the transport from user shell plugins.
- Desktop and 390 px mobile layouts, readonly secondary attachment, explicit control takeover, resize propagation, and returning to the original shell.
- A real curses alternate-screen TUI retained its screen across Agent and Hub restarts. Its parent shell retained the exported environment variable.
- The installed Codex TUI launched and rendered through the public terminal and remained visible after resizing. No model task was submitted and no Codex configuration was changed.
- Offline termination: the task remained alive while the Agent was stopped; the Hub saved the termination request; reconnecting the Agent stopped the dedicated terminal unit and updated observed state.
- Unrelated pre-existing terminal services remained active. Existing application containers on the public server were not recreated.

Commands for repeating deployment acceptance:

```sh
WORKDECK_TEST_URL=https://work.example.com python3 scripts/check-offline-close.py
cd web
WORKDECK_TEST_URL=https://work.example.com \
WORKDECK_TEST_SSH_TARGET=deploy@server.example.com \
WORKDECK_RECOVERY=1 WORKDECK_CODEX=1 npx playwright test
```

The recovery test intentionally restarts the new Workdeck Agent and Hub, detaching current viewers temporarily. Run it during an appropriate maintenance window. Its terminal processes survive these restarts.

Ignored local screenshots and reports are under `test-results/` and `web/test-results/`.

Observed host behavior: the current user's zsh plugins spend substantial CPU on extremely long command lines. Clean Bash accepts the same large paste promptly. Workdeck preserves the user's shell configuration; shell plugin performance is separate from terminal transport. The mobile paste button uses xterm's paste handling, including bracketed paste when requested by the running application.

## Directory selection, restart reconciliation, and device sessions

Additional acceptance completed for a Hub-host compute Agent and a separate Linux arm64 Agent:

- The Hub host can enroll a normal-user Agent through the same identity and reverse-connection protocol as other nodes.
- Existing databases migrate additively: nodes, terminal metadata, account hashes, and device sessions remain present.
- Full inventories reconcile missing sessions to lost; incomplete inventories preserve the last known state for omitted records. Node boot identifiers and atomically saved Agent metadata distinguish process loss after a reboot.
- Go tests reopen the real SQLite database in a fresh Hub instance, retain two independent logins and node/terminal records, then synchronize a simulated node reboot. Cookie persistence, renewal, and device-local logout are also covered.
- Real browser acceptance navigates node child directories and parents, creates a terminal in the chosen folder, and verifies its working directory through the running Shell.
- A persistent Chromium profile is closed and reopened without another login; a second device remains logged in after the first device logs out.
- Public endpoint acceptance also rechecks Codex TUI rendering, real Agent/Hub service restarts with a running curses TUI, mobile control takeover, and large Unicode paste transport.

No host OS was rebooted during acceptance, so other applications were not interrupted. Boot-time Docker/Agent configuration was checked separately. A full OS reboot preserves records and credentials, but ends the processes on that host; the UI retains lost records and offers explicit recreation in the prior directory.

The final deployed suite passed all five cases on the separate compute node. A second run passed directory selection and desktop/mobile terminal lifecycle on the Hub-host Agent with tmux 3.0a. Explicit controller-driven window sizing was checked alongside the other node’s tmux 3.2a. Total: seven public browser acceptance cases passed.

## Password policy, node rename, and root service migration

The final password policy is at least six characters containing both an English letter and a digit; either letter case is accepted. No password-specific maximum is imposed. Initialization and password changes enforce this rule, while existing bcrypt and versioned hashes remain readable. Regression tests accept lowercase/uppercase combinations and long Unicode inputs, reject short/letters-only/digits-only values, and verify older noncompliant credentials can still log in to set a compliant password.

Node rename is authenticated and CSRF protected, works offline, changes only the display name, and survives reopening the Hub database. Public browser acceptance enrolls an isolated temporary node, renames it in the UI, reloads, verifies its ID is unchanged, and then revokes the test identity.

The Hub-host Agent was migrated to a root-owned system service. Its node ID and session records were retained, its node signing key was rotated into root-only storage, and the earlier ordinary-user Agent was disabled. Retained sessions keep their original OS account and service scope. New terminals use the actual service account; the UI reports that account on each node.

Acceptance passed seven standard public browser cases plus four root-host cases. The root terminal printed `whoami=root` and UID `0`, retained its shell environment across a system Agent restart, and supported directory selection and desktop/mobile takeover. A surviving pre-migration ordinary-user terminal remained reachable without sending input to or terminating it. All eleven relevant browser cases passed; no production administrator password was changed by these tests.

## Styled rename and termination forms

Node and terminal rename now use the same modal styles as terminal creation and password changes. Terminal termination uses a site dialog showing the terminal and node, with explicit cancel/confirm buttons and an offline delivery notice when applicable. Opening confirmation from fullscreen exits fullscreen so the dialog is visible.

Three browser acceptance cases passed against an isolated Hub and real local compute Agent: password form validation, offline node rename with a stable identity, and terminal rename/termination. The terminal case verifies that rename retains the running shell environment, cancelling confirmation sends no DELETE request, confirming sends exactly one, and no browser-native dialogs appear. Fullscreen visibility and both modal screenshots were also checked. The production frontend was deployed and its health endpoint returned OK; authenticated production acceptance was unavailable with the saved test credentials. The current production password was preserved.

## Agent reconnect after an idle terminal detaches

A production Agent stack dump identified control reconnection waiting indefinitely for an old cross-account `runuser` terminal attachment to exit. The attachment sent SIGHUP only to the wrapper and waited without a deadline. PTY setup and resize also invoked `File.Fd`, which put the master into blocking mode.

Attachment cleanup now cancels transport first and terminates the viewer's separate process group, escalating after two seconds. The persistent tmux server and terminal are outside that group. PTY reads use nonblocking polling, and resize uses `SyscallConn` without changing descriptor mode.

Regression tests disconnect the control connection three times with an attached idle, resized terminal, verify automatic reconnection, and verify the original pane PID survives. They also cover a wrapper that ignores termination. Both cases passed locally with the race detector and on the deployment host with a root Agent attaching to a different account. The complete Go test suite and `go vet` passed.

## Optional measured direct transport

Ten browser acceptance cases passed against an isolated Hub and a real local Agent. New coverage verifies actual terminal bytes arrive over a browser WebRTC DataChannel while Hub WebSockets carry no corresponding binary output; a continuous numbered output stream crosses the route switch without lost or duplicate lines. A deliberately delayed but reachable direct path retains relay delivery. Browsers without WebRTC retain working terminals.

The same acceptance verifies direct readonly access rejects injected binary input, another device can take control, logout closes that device's direct peer, and a closed active peer reconnects over relay with the original shell environment and terminal record intact. Existing mobile resize, directory selection, persistent login, rename, and styled termination cases also pass. Screenshots include the mobile direct indicator and relay recovery.

Go tests cover the output fence and matching commit, stale/readonly controller tickets, failed speculative probes leaving the relay intact, and existing Agent reconnect behavior. The complete Go suite passed with the race detector, and `go vet` passed. Deployment-host tests also pass under root with a separate terminal owner, retaining the original pane PID through three control disconnects. These tests demonstrate the selection and fallback mechanism; NAT traversal success on other networks is environment-dependent and does not gate terminal access.

## Visible terminal network metrics

Six relevant browser cases passed against the existing Agent protocol, including automatic selection/fallback, a slower-but-reachable direct path, a browser without WebRTC, metric calculations, mobile terminal lifecycle, and styled modal actions. The network panel shows both path RTTs and the committed active path, browser-direction transfer rates, per-path totals, jitter and recent application probe timeouts. Unknown/unsupported/stale values are distinct from measured zero traffic.

Acceptance sends a real output stream and compares the displayed direct upload/download totals with independent counters on the actual RTCDataChannel binary frames. It also verifies nonzero transfer rates during output and that the unused relay's measurement timestamp advances while direct is active. The slower direct case visibly retains relay delivery and reports the latency difference; the unsupported browser still receives end-to-end relay RTT. Desktop and narrow-screen screenshots were inspected, including the expanded route/metric cards. This browser-only change remains compatible with the previously deployed Agents.

## Wheel scrollback and keyboard command history

Six relevant browser cases passed: dedicated scrollback cases on both relay and direct transports, the three automatic transport/fallback cases, and desktop/mobile terminal lifecycle. Each scrollback case fills a real Bash terminal with numbered output, retains an unsubmitted draft, and verifies the wheel reveals older output while sending genuine mouse reports rather than cursor keys. Scrolling down restores the same draft; physical Up/Down recall prior commands and restore the draft even immediately after scrolling. Typing after scrolling returns to live input. Reconnection still exposes tmux's earlier history. A real mouse-aware curses TUI receives wheel events and a separately pressed Up key without confusing them.

Agent race tests and the Go suite pass. Deployment-host compatibility tests run under root against a different session owner on the older tmux release, verifying existing servers receive mouse and both copy-table arrow bindings without changing their pane PID, including repeated reconnects. Configuration is applied as command arguments, avoiding any need for the previous account to read root-only configuration files.

Positive direct-path acceptance adds a small test-only delay to relay probe replies so localhost scheduling noise cannot unexpectedly choose the relay instead of the path the test needs to exercise. Actual terminal data is not delayed; production path selection is unchanged.
