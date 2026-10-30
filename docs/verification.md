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
