# 开发与贡献

欢迎提交问题和改进。普通问题可使用 GitHub Issues；涉及身份认证、私钥或远程执行的问题，请先阅读 [安全反馈](SECURITY.md)，避免公开真实凭证。

## 环境与目录

需要 Linux、Go 1.25+、Node.js 22+、Python 3；运行真实节点还需要 tmux、systemd。目录职责见 README。Hub、Agent 使用同一个 Go 命令入口；前端是独立的 Vite 项目。

```sh
npm ci --prefix web
npm run build --prefix web
go build -o bin/workdeck ./cmd/workdeck
```

不要跳过 npm 的安装脚本：它会应用固定版本的 xterm 渲染修复，依赖升级若改变替换位置会主动失败。修改渲染器后运行 `terminal-dom-rendering.spec.ts` 和真实节点的末列回归。

## 隔离开发实例

按 README 生成私有初始密码，然后启动独立 Hub：

```sh
bin/workdeck hub --addr 127.0.0.1:18090 \
  --public-url http://127.0.0.1:18090 --data-dir .secrets/dev-hub \
  --admin-password-file .secrets/administrator.txt
```

在界面生成接入令牌，将令牌存到权限为 0600 的私有文件后，在另一个终端接入独立 Agent：

```sh
bin/workdeck agent enroll --hub http://127.0.0.1:18090 \
  --name dev-node --data-dir .secrets/dev-agent --token-file .secrets/join-token
bin/workdeck agent run --data-dir .secrets/dev-agent
```

不要对同一个数据目录同时启动多个 Agent，不要将测试 Hub 指向生产数据库。普通用户的终端依赖可用的 systemd 用户管理器；root 使用系统级管理器。

## 检查与测试

```sh
gofmt -w cmd internal
go test -race ./...
go vet ./...
npm run build --prefix web
cd web
npx playwright install chromium
# 无需 Hub 的逻辑及 DOM 渲染测试
npx playwright test transport-policy.spec.ts network-metrics.spec.ts terminal-dom-rendering.spec.ts
# 连接隔离 Hub 的完整交互验收
WORKDECK_TEST_URL=http://127.0.0.1:18090 \
WORKDECK_TEST_NODE_NAME=dev-node npx playwright test
```

认证密码默认读取 `../.secrets/administrator.txt`，可用 `WORKDECK_TEST_PASSWORD_FILE` 覆盖。完整测试需要已在线的测试节点；真实服务重启、root、Codex 及直连测试使用单独开关，见 [验证指南](docs/verification.md)。

修改依赖后检查 `npm audit --omit=dev --prefix web --registry=https://registry.npmjs.org`，并执行 `python3 scripts/update-notices.py` 更新第三方版权清单。更新依赖锁文件时审查版本与许可，不要无关升级。

## 提交规范与脱敏

- 尽量围绕一个行为提交，说明触发条件、改动和验证结果。
- 保留用户正在执行的任务；连接重试与升级不得重放未知输入或自动重建进程。
- 新增文档使用中文；标识符、协议字段和上游许可原文保持原样。
- `.env.deploy.local`、密码、节点身份、数据库、终端内容、截图、HAR、私有 Git 备份不能提交。
- 运行 `python3 scripts/check-publication.py --history`，并人工检查 `git diff --cached`。可通过 `--deny-file` 加载私有词表检查真实域名、地址和个人路径，词表本身必须位于被忽略的目录。
- 不要使用 `git add -f` 绕过忽略规则。

GitHub Actions 会运行 Go 检查、前端构建和无需生产环境的浏览器回归。涉及真实节点的行为还需按验证指南完成隔离验收。
