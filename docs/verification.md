# 验证指南与验收记录

## 不连接生产环境的检查

```sh
go test -race ./...
go vet ./...
for script in scripts/*.sh; do sh -n "$script"; done
npm ci --prefix web
npm run build --prefix web
python3 scripts/check-publication.py --history
cd web
npx playwright install chromium
npx playwright test transport-policy.spec.ts network-metrics.spec.ts terminal-dom-rendering.spec.ts
npx playwright test terminal-first-paint.spec.ts
```

Go 测试覆盖登录、CSRF / Origin、节点接入及重试、防重放、改密撤销、状态恢复、目录读取、服务账户和附着连接清理。前端独立用例覆盖链路选择、网络统计和实际 xterm DOM 渲染，不需要 Hub 或计算节点。

保存过程中的磁盘满和权限撤销测试需要独立、小容量的 tmpfs。下面的容器只在临时内存文件系统内填满空间，不操作宿主机的数据目录；测试会拒绝非 tmpfs 或大于 32 MiB 的测试路径：

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --tmpfs /faulttmp:rw,size=12m,mode=1777 \
  -v "$PWD:/src" -w /src \
  -e WORKDECK_DISK_FULL_ROOT=/faulttmp golang:1.25-alpine \
  go test ./internal/files -run 'TestUploadQuotaDoesNotChangeFiles|TestPermissionRevokedDuringSavePreservesOriginal|TestDiskFullPreservesOriginalAndAllowsRetry' -count=1 -v
```

容器需要可下载 Go 依赖；权限撤销测试需要非 root 账户。未设置专用测试路径时，磁盘满测试会跳过。

## 完整交互验收

按 [开发指南](../CONTRIBUTING.md) 创建独立 Hub、独立 Agent 数据目录，再运行：

```sh
cd web
WORKDECK_TEST_URL=http://127.0.0.1:18090 \
WORKDECK_TEST_NODE_NAME=dev-node \
WORKDECK_TEST_PASSWORD_FILE=../.secrets/administrator.txt \
  npx playwright test
```

可通过 `CHROMIUM_PATH` 指定已有 Chromium。测试密码从本地私有文件读取，不写在命令行。用例创建和清理自己的终端；仍应使用隔离节点，避免真实用户工作受到服务重启或控制权变化影响。

默认不会执行所有外部环境相关用例：

| 开关 | 作用 |
| --- | --- |
| `WORKDECK_DIRECT_ACCEPTANCE=1` | 执行真实 DataChannel 及直连回退验收，需环境允许建立本地或公网直连 |
| `WORKDECK_FILE_TEST_ROOT` | 指定独立测试目录，运行工作区文件及多终端切换验收；测试会创建并删除自己的文件和终端 |
| `WORKDECK_TEST_ALT_MODE=tailnet` | 与直连验收开关同时设置时，让独立候选测试使用节点的 Tailscale 接口；测试节点需要该接口 |
| `WORKDECK_TEST_ALT_FROM_DIRECT=1` | 与直连验收开关同时设置时，验证从现有直连经有序切换迁移到更优候选 |
| `WORKDECK_TEST_TAILNET_HOST` 和 `WORKDECK_TEST_PUBLIC_HOST` | 显式指定测试用 Tailnet 主机名与公网 TLS 域名，运行节点侧 Tailnet 备用连接和证书校验测试 |
| `WORKDECK_RECOVERY=1` | 执行服务重启恢复验收，需配置测试用 SSH 目标与服务管理权限 |
| `WORKDECK_CODEX=1` | 执行节点已安装 Codex 的 TUI 显示验收，不提交模型任务 |
| `WORKDECK_OFFLINE_ACCEPTANCE=1` | 允许 Python 离线终止验收停止本机用户 Agent，仅用于隔离环境 |
| `WORKDECK_ROOT_ACCEPTANCE=1` | 执行 root 计算节点验收，需匹配的节点及重启权限 |
| `WORKDECK_FILE_RATE_ACCEPTANCE=1` | 验证同一账户的并发文件上传下载共享限速；仅用于配置了 262144 字节/秒、独立数据目录和回环 Hub 的测试 Agent，同时指定 `WORKDECK_FILE_TEST_ROOT` 和测试节点名称 |
| `WORKDECK_ARCHIVE_ACCEPTANCE=1` | 在支持旧操作查询的隔离节点验证旧修订日志和本地记录恢复；设置 `WORKDECK_ARCHIVE_DIRECT=1` 可强制测试文件 WebRTC 直连 |
| `WORKDECK_PENDING_DIRECT=1` | 在独立回环节点强制通过文件 WebRTC 直连验证节点待处理写入的核对和竞争保护 |

各用例的其他参数以 `web/tests/` 中的实际读取项为准。重启测试会短暂断开查看者，只应在隔离环境或明确维护窗口执行。

`python3 scripts/check-offline-close.py` 可验证离线终止的状态同步；需要在线测试 Hub、测试节点及私有认证文件，使用前先阅读脚本参数。

## 一键部署验收

以下命令从本地源码构建全新 Docker 实例，只绑定本机端口，不接管生产 Caddy：

```sh
sh scripts/install-hub.sh --local --port 18890 \
  --project workdeck-smoke --dir "$PWD/.secrets/deploy-smoke" --source "$PWD"
curl -fsS http://127.0.0.1:18890/healthz
```

应验证初次登录、Agent 下载校验、节点登记、创建终端和独立容器重启后数据恢复。再次执行安装命令，应保留数据库、初始密码和已配置的参数。测试结束后仅清理明确属于该隔离项目的容器和卷，不使用泛化的 Docker 清理命令。

独立 HTTPS 部署还需验证 DNS、80 / 443、证书申请及 WSS。本机 HTTP 健康通过不代表真实域名和证书已配置完成。

## 表单与主题下拉框

“新建终端”和“新建 Codex”分别验收。检查节点代理保存、重启恢复、切换节点自动填入、单次修改不覆盖默认值和浏览器存储中不出现代理。代理接口必须验证登录与 CSRF，数据库不保存明文地址。

全部选择控件使用统一 listbox：检查方向键、Home / End、Enter、Escape、Tab、禁用选项、选中标记及视口边缘翻转。Escape 应先关闭下拉框，保留外层对话框或网络 / 字号面板；点击选项不能被父面板误判为外部点击。切换字号、链路策略或目录不能重建终端进程。

## 已验证的核心行为

以下记录来自 Linux arm64 / amd64、systemd、tmux 和 Chromium 的实际验收；公开记录不包含真实主机地址、用户名、工作路径或原始部署标识。

- 浏览器创建终端、真实 Shell 输入输出、刷新和断开后保留环境变量，后台任务在断开期间继续完成。
- 长中文粘贴跨多个输入帧完整到达；桌面和约 390 px 移动端可使用，只读查看与接管权限分离。
- curses 备用屏幕在 Hub / Agent 服务重启后保持原画面，父 Shell 环境保留；现有 Codex TUI 可显示和缩放。
- 受管 Codex 显式使用所选目录；已用真实 TUI 验证带空格的目录与 `/resume` 请求中的目录筛选，不提交模型任务。UUID 恢复也已验证目录覆盖、`/resume` 筛选和所选审批 / 沙箱权限保留。
- Agent 离线期间 Hub 保存终止意图，重新连接后停止专属单元并更新观测状态。
- 目录选择支持主目录、上级、子目录、隐藏项与手工路径，读取权限与节点账户一致。
- 独立浏览器会话在关闭后保留，多个设备互不挤出；退出仅影响当前设备，改密撤销其他登录。
- 节点离线重命名不改变 ID，重启后保留。节点安装账户决定新终端账户，root Agent 可连接原普通账户的会话。
- 重命名与终止使用站内表单；取消不会发出终止请求，全屏模式也能显示确认界面。
- 多次断线和跨账户附着清理不会阻塞 Agent 重连；临时连接进程组被回收，持久 pane 进程不变。
- 中转立即可用；真实直连、较慢直连保留中转、断线回退、接管和注销撤权均有测试。正向直连用例仅延迟测试环境的中转探测回复，终端数据与生产策略不变。
- 网络面板区分未知、不可用、过期和实测零值，使用实际时间计算字节速率，不把探测超时展示为网络丢包率。
- 滚轮查看 tmux 历史，不合成 Shell 上下键；实体键盘上下键仍切换历史命令，滚动后输入自动回到实时画面。鼠标感知 curses TUI 保留原生事件。
- 末行在窄屏、横屏、全屏、网络详情展开及字号变化时不被底部状态栏遮挡。
- 字号即时生效，不重建连接；同一浏览器跨标签页同步、刷新记忆，不同设备独立。

## 末列文字截断的专项回归

xterm 5.5.0 DOM 渲染存在两类误差：32 个字符的字宽样本使用整数 `offsetWidth`，会带来逐字累积误差；即使修正测量，逐字变色 / 粗细切换产生的多个 inline-block 片段仍会分别取整，继续累积。

`patch-xterm-dom.mjs` 保留小数测量，并将每个文字片段定位到逻辑列坐标。补丁严格检查依赖版本与替换位置，检查全部通过后才写入文件。升级依赖需重新审查，不能静默跳过补丁。

无需 Hub 的回归覆盖三种字体栈、六种字号和四种设备像素比例，检查逐字变色、粗细交替、中文和真彩色片段。该测试在上一版补丁上确认失败，新补丁后通过。真实 curses 用例覆盖四种窗口宽度、六种字号及三个设备像素比例，共 72 种组合，直接检查节点程序报告的列数和实际末列字符。

该修复已部署并核对线上资源哈希；原有终端进程保持不变。Mac Chrome、100% 缩放的反馈用户已确认显示恢复正常。自动化环境为 Linux Chromium，未声称完成所有浏览器和真实 Mac 的自动化验收。

## 输出与局限

截图、日志、Playwright 报告默认保存在 Git 忽略目录中。失败报告可能包含页面输入框的密码文本，不能原样发布。

测试通过只反映所用版本和环境。系统断电或重启不会恢复原进程；本项目不提供进程检查点和未知任务重放。Shell 插件、字体可用性、网络防火墙和其他外部工具的行为仍需按实际环境排查。

## 开源发布整理的部署验证

独立 Docker 多阶段构建已在 Linux arm64 上完成，未使用宿主机 Go / Node 参与安装。验证了初次登录、两个架构的 Agent 下载与 SHA256 校验、真实节点接入、终端创建和输入输出、移动端尺寸、只读 / 接管及站内确认表单。

重复运行安装器保留私有参数和初始密码。重启 Hub 容器后，既有登录 Cookie、CSRF、节点 ID、运行终端的 pane PID 和管理状态均保留。独立 Caddy 配置及 HTTPS Compose 配置通过校验；新的真实域名仍需部署者完成 DNS 和证书验收。

Go 竞态测试、静态检查、前端逻辑 / DOM 回归、源码格式和生产依赖审计均已执行。第三方许可清单在 amd64 / arm64 解析结果一致。全部可达 Git 历史和当前文件均检查了已知私有凭证及基础设施值；未把私有检测词表、测试报告或运行数据加入仓库。
