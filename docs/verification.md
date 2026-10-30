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
