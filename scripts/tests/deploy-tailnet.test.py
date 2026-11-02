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
    result = run("", "0")
    assert result.returncode != 0 and "Tailnet probe is enabled remotely" in result.stderr
    assert env.read_text() == original
    result = run("https://example.ts.net:18443/probe", "0")
    assert result.returncode != 0 and "secret file is missing or unsafe" in result.stderr
    assert env.read_text() == original
print("Tailnet deploy preflight protects existing configuration and requires a secret.")
