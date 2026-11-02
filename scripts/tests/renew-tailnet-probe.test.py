#!/usr/bin/env python3
"""Exercise certificate update and rollback with isolated fake commands."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / "renew-tailnet-probe.sh").read_text()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    state = root / "state"
    private = root / "private"
    commands = root / "bin"
    state.mkdir(); private.mkdir(); commands.mkdir()
    old = state / "cert.old"
    old.mkdir(); (old / "cert.pem").write_text("old-cert"); (old / "key.pem").write_text("old-key")
    (state / "current").symlink_to("cert.old")
    script = source.replace("state=/var/lib/workdeck-tailnet-probe", "state=" + shlex.quote(str(state))).replace("private=/opt/stacks/workdeck/secrets/tailnet-probe", "private=" + shlex.quote(str(private)))
    def fake(name, body):
        p = commands / name
        p.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
        p.chmod(0o700)
    fake("tailscale", 'while [ "$#" -gt 0 ]; do case "$1" in --cert-file) cp "$WD_CERT" "$2"; shift 2;; --key-file) cp "$WD_KEY" "$2"; shift 2;; *) shift;; esac; done')
    fake("openssl", 'case "$1" in x509) case " $* " in *" -pubkey "*) echo public-key;; esac;; pkey) echo public-key;; sha256) cat >/dev/null; echo digest;; esac')
    fake("chown", "exit 0")
    fake("install", 'while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; -m) mode="$2"; shift 2;; *) break;; esac; done; /usr/bin/install -m "$mode" "$1" "$2"')
    fake("systemctl", 'echo restart >> "$WD_CALLS"; [ "${WD_FAIL_RESTART:-0}" = 0 ]')
    env = os.environ.copy()
    env.update(PATH=str(commands)+":"+env["PATH"], WD_CERT=str(root/"new-cert"), WD_KEY=str(root/"new-key"), WD_CALLS=str(root/"calls"))
    (root/"new-cert").write_text("old-cert"); (root/"new-key").write_text("old-key")
    def run():
        return subprocess.run(["sh", "-s", "--", "example.ts.net"], input=script, env=env, capture_output=True, text=True, timeout=5)
    assert run().returncode == 0 and os.readlink(state/"current") == "cert.old"
    assert not (root/"calls").exists()
    (root/"new-cert").write_text("new-cert"); (root/"new-key").write_text("new-key")
    env["WD_FAIL_RESTART"] = "1"
    result = run()
    assert result.returncode != 0 and os.readlink(state/"current") == "cert.old"
    assert len((root/"calls").read_text().splitlines()) == 2
    env["WD_FAIL_RESTART"] = "0"
    result = run()
    assert result.returncode == 0 and os.readlink(state/"current") != "cert.old"
    assert (state/"current"/"cert.pem").read_text() == "new-cert"
    assert (state/"current"/"key.pem").read_text() == "new-key"
print("Tailnet certificate renewal preserves, switches and rolls back certificate pairs.")
