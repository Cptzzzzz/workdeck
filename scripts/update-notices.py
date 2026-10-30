#!/usr/bin/env python3
"""从已安装的运行时依赖更新第三方许可清单，不联网抓取或改写许可原文。"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "third_party" / "licenses"


def json_stream(text):
    decoder = json.JSONDecoder()
    while text.strip():
        value, end = decoder.raw_decode(text.lstrip())
        yield value
        text = text.lstrip()[end:]


def output(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True)


def main():
    modules = {}
    for package in json_stream(output("go", "list", "-deps", "-json", "./cmd/workdeck")):
        module = package.get("Module", {})
        if module and not module.get("Main"):
            modules[module["Path"]] = (module["Version"], Path(module["Dir"]))
    entries = [("Go 标准库", "随 Go 工具链", Path(output("go", "env", "GOROOT").strip()))]
    entries += [(name, version, path) for name, (version, path) in sorted(modules.items())]
    for path in output("npm", "ls", "--omit=dev", "--parseable", "--all", cwd=ROOT / "web").splitlines()[1:]:
        directory = Path(path)
        info = json.loads((directory / "package.json").read_text())
        entries.append((info["name"], info["version"], directory))
    OUT.mkdir(parents=True, exist_ok=True)
    written = set()
    rows = []
    for name, version, directory in entries:
        files = sorted(p for p in directory.iterdir() if p.is_file() and p.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")))
        if not files:
            raise SystemExit(f"未找到许可原文：{name} {version}；请人工核对。")
        links = []
        for source in files:
            key = ("go-standard-library" if name == "Go 标准库" else re.sub(r"[^a-zA-Z0-9_.-]", "_", name)) + "--" + source.name + ".txt"
            (OUT / key).write_bytes(source.read_bytes())
            written.add(key)
            links.append(f"[{source.name}](third_party/licenses/{key})")
        rows.append(f"| {name} | {version} | {', '.join(links)} |")
    for path in OUT.glob("*.txt"):
        if path.name not in written:
            path.unlink()
    header = """# 第三方组件与许可

Workdeck 自身使用 [MIT 许可证](LICENSE)。以下列出编译进 Linux 服务端/Agent 的 Go 依赖、Go 标准库和前端运行时依赖。第三方许可原文保留上游语言与版权声明，不受本项目文档中文化影响。

xterm.js 5.5.0 包含本项目的字宽测量与逻辑列定位补丁，见 `scripts/patch-xterm-dom.mjs`；上游版权声明保持不变。开发工具、构建基础镜像和独立运行的 Caddy、tmux、systemd 各自遵循其上游许可。

清单由 `python3 scripts/update-notices.py` 生成；升级依赖后，在完成 `npm ci --prefix web` 和 Go 依赖安装的环境重新生成。容器在 `/licenses/` 内携带本项目和第三方许可文件。

| 组件 | 版本 | 许可原文 |
| --- | --- | --- |
"""
    (ROOT / "THIRD_PARTY_NOTICES.md").write_text(header + "\n".join(rows) + "\n")
    print(f"已更新 {len(entries)} 个组件、{len(written)} 份许可文件。")


if __name__ == "__main__":
    main()
