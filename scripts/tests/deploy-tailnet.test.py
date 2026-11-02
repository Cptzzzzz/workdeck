#!/usr/bin/env python3
"""Verify deploy's remote preflight rejects unsafe Tailnet changes before mutation."""
from pathlib import Path
import subprocess
import tempfile

script = (Path(__file__).resolve().parents[1] / "deploy.sh").read_text()
start = script.index("set -eu\nversion=\"$1\"; root=\"$2\"")
end = script.index("\nREMOTE", start)
remote = script[start:end] + "\n"
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "secrets").mkdir()
    env = root / ".env"
    original = "WORKDECK_TAILNET_PROBE_URL=https://example.ts.net:18443/probe\n"
    env.write_text(original)
    def run(url, disabled):
        return subprocess.run(
            ["sh", "-s", "--", "test", directory, "https://work.example.com", "network", "", "/tmp/caddy", "caddy", "work.example.com", "720h", url, disabled],
            input=remote, text=True, capture_output=True, timeout=5,
        )
    # The deployment encodes empty SSH arguments as '-' so the remote shell
    # does not shift later arguments before the guard runs.
    result = run("-", "0")
    assert result.returncode != 0 and "Tailnet probe is enabled remotely" in result.stderr
    assert env.read_text() == original
    result = run("https://example.ts.net:18443/probe", "0")
    assert result.returncode != 0 and "secret file is missing or unsafe" in result.stderr
    assert env.read_text() == original
print("Tailnet deploy preflight protects existing configuration and requires a secret.")

# A remote script failure must not retry an already-consumed stdin stream.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    fake = root / "ssh"
    fake.write_text('#!/bin/sh\ncat >/dev/null\nprintf x >> "$WORKDECK_TEST_CALLS"\nexit 7\n')
    fake.chmod(0o700)
    function = script[script.index("ssh() {"):script.index('\ncd "$(dirname')]
    command = "set -e\n" + function + "\nssh example sh -s <<'REMOTE'\nexit 7\nREMOTE\nprintf unexpected-success\n"
    import os
    env = os.environ.copy()
    env["PATH"] = directory + ":" + env["PATH"]
    env["WORKDECK_TEST_CALLS"] = str(root / "calls")
    result = subprocess.run(["sh", "-c", command], env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 7 and "unexpected-success" not in result.stdout
    assert (root / "calls").read_text() == "x"
print("A failed remote script is not retried with exhausted stdin.")
