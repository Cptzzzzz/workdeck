#!/usr/bin/env python3
"""Verify each service start uses the current Tailscale address."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / "start-tailnet-probe.sh").read_text()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    tailscale = root / "tailscale"
    tailscale.write_text('#!/bin/sh\nprintf "%s\\n" "$WD_FAKE_TAILNET_IP"\n')
    tailscale.chmod(0o700)
    binary = root / "probe"
    binary.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$WD_ARGS"\n')
    binary.chmod(0o700)
    source = source.replace("/usr/local/libexec/workdeck-tailnet-probe", shlex.quote(str(binary)))
    env = os.environ.copy()
    env.update(PATH=directory+":"+env["PATH"], WD_ARGS=str(root/"args"), WD_FAKE_TAILNET_IP="100.64.0.10")
    def run(origin, port):
        return subprocess.run(["sh", "-s", "--", origin, port], input=source, text=True, capture_output=True, env=env, timeout=5)
    assert run("https://work.example.com", "18443").returncode == 0
    assert "--addr=100.64.0.10:18443" in (root/"args").read_text().splitlines()
    env["WD_FAKE_TAILNET_IP"] = "100.64.0.11"
    assert run("https://work.example.com", "18443").returncode == 0
    assert "--addr=100.64.0.11:18443" in (root/"args").read_text().splitlines()
    assert run("http://work.example.com", "18443").returncode != 0
    assert run("https://work.example.com", "65536").returncode != 0
    env["WD_FAKE_TAILNET_IP"] = ""
    assert run("https://work.example.com", "18443").returncode != 0
print("Tailnet probe startup uses the current address and rejects invalid configuration.")
