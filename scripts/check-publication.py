#!/usr/bin/env python3
"""检查受 Git 跟踪的文件；可选检查全部可达历史及私有脱敏词表。"""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = [
    ("私钥原文", re.compile(rb"-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----")),
    ("GitHub 访问凭证", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b")),
    ("AWS 访问标识", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def private_path(name):
    path = Path(name)
    if path.name.startswith(".env") and not path.name.endswith(".example"):
        return True
    return bool(set(path.parts) & {".secrets", "node_modules", "test-results", "playwright-report"}) or path.name in {
        "identity.json", "enrollment.json", "admin_password", "administrator.txt",
    } or path.suffix.lower() in {".db", ".key", ".pem", ".p12", ".pfx", ".har", ".log", ".bundle"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true", help="同时扫描全部可达提交和对象")
    parser.add_argument("--deny-file", type=Path, help="私有词表，每行一个需要剔除的实际敏感值；不要提交该文件")
    args = parser.parse_args()
    denied = args.deny_file.read_bytes().splitlines() if args.deny_file else []
    denied = [value.strip() for value in denied if value.strip()]
    failures = []
    count = 0

    def scan(label, data):
        nonlocal count
        count += 1
        for reason, pattern in PATTERNS:
            if pattern.search(data):
                failures.append((label, reason))
        if any(value in data for value in denied):
            failures.append((label, "命中私有脱敏词表"))
        if data.startswith((b"\x7fELF", b"SQLite format 3\x00")):
            failures.append((label, "可执行文件或运行数据库"))

    for raw in git("ls-files", "-z").split(b"\0"):
        if not raw:
            continue
        name = raw.decode()
        if private_path(name):
            failures.append((name, "运行数据或私有文件受 Git 跟踪"))
        path = ROOT / name
        if path.is_file():
            scan(name, path.read_bytes())
    if args.history:
        for line in git("rev-list", "--objects", "--all").splitlines():
            oid, _, raw_name = line.partition(b" ")
            name = raw_name.decode(errors="replace")
            if name and private_path(name):
                failures.append((oid.decode(), "历史包含私有文件路径"))
            kind = git("cat-file", "-t", oid.decode()).strip()
            if kind in {b"blob", b"commit", b"tag"}:
                scan(oid.decode(), git("cat-file", "-p", oid.decode()))
    if failures:
        for label, reason in failures:
            print(f"失败：{label}：{reason}")
        raise SystemExit(1)
    print(f"通过：检查 {count} 个文件 / 历史对象，未命中已配置的敏感模式。")
    print("自动检查不能识别所有秘密；仍需人工检查差异、基础设施信息及测试输出。")


if __name__ == "__main__":
    main()
