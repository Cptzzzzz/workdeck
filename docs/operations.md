# 运维手册

以下使用示例域名和默认独立部署目录，请按自己的私有配置替换，不要把实际凭证提交到仓库。

## 状态、日志与健康检查

```sh
cd /opt/workdeck
docker compose ps
docker compose logs --tail 100 hub
curl -fsS https://work.example.com/healthz

# 普通账户 Agent
systemctl --user status workdeck-agent
journalctl --user -u workdeck-agent -n 100 --no-pager
systemctl --user list-units 'workdeck-session-*'

# root Agent 使用系统单元，不加 --user
sudo systemctl status workdeck-agent
sudo journalctl -u workdeck-agent -n 100 --no-pager
```

日志、截图、终端输出和浏览器错误报告可能包含工作内容或登录信息，分享前先脱敏。

## 服务重启与升级

```sh
cd /opt/workdeck
docker compose restart hub
systemctl --user restart workdeck-agent
# root Agent 改用 sudo systemctl restart workdeck-agent
```

这些操作会短暂断开浏览器，但独立 tmux 会话继续运行。Agent 指数退避重连并上报完整清单；浏览器自动重试，不重放按键。

独立部署重复执行原一键安装命令即可更新 Hub。已有 Caddy 远程部署使用 `scripts/build.sh`、`scripts/deploy.sh`。标准 Agent 安装可由原安装账户执行 `sh install-agent.sh --hub https://work.example.com --upgrade`，校验并原子替换 Agent；root Agent 同步安装匹配的 `/usr/local/libexec/workdeck-file-worker`。只重启 Agent 服务，勿停止 `workdeck-session-*` 单元。非标准路径和手动服务请按实际配置升级；root 服务的工作程序与 Agent 必须使用完全相同的构建版本。

## 备份与恢复

SQLite 使用 WAL。应使用在线备份 API，或短暂停止 Hub 后复制完整数据目录；不要在持续写入时只复制单独的 `workdeck.db`。

独立部署可先停止 Hub，再从命名卷导出：

```sh
cd /opt/workdeck
mkdir -p backups
chmod 700 backups
docker compose stop hub
# 将当前项目实际的卷名替换到此处，默认项目名下如下。
docker run --rm -v workdeck-standalone_hub-data:/data:ro \
  -v "$PWD/backups:/backup" alpine:3 \
  tar -czf /backup/hub-data.tar.gz -C /data .
docker compose start hub
```

同时备份私有 `.env`、初始化密码和 Caddy 证书卷。已有 Caddy 方案备份其 `data/` 目录。完整数据库、证书和身份备份均应作为敏感数据保存。

每个节点的 `~/.local/share/workdeck` 需另外备份。恢复到空数据卷前停止 Hub，解压后保持 UID/GID 65532 的权限，再启动。节点身份恢复要对应原节点，避免两个 Agent 同时使用同一身份。

记录备份不包含操作系统进程内存。系统重启后的会话会被标记丢失，不能靠 JSON / SQLite 恢复正在执行的任务。

## 终端字号与滚轮

终端工具栏的字号按钮支持 10–24 px，默认 13 px。修改即时生效，不重新连接终端；同一浏览器记忆设置并同步到其他标签页，不同设备独立。只读查看者可调整自己的显示。设置仅保存在本机 `workdeck.terminal.fontSize`，不包含凭证。

滚轮查看保留的 tmux 历史；滚回提示符或直接开始输入可回到实时画面。实体键盘及移动端上下键保留 Shell 的历史命令行为。支持鼠标的 TUI 接收点击和滚轮事件；普通鼠标拖动选择终端文本。Windows 或 Linux 有选区时用 Ctrl+C 复制，无选区时发送中断；macOS 使用 Command+C 复制，Control+C 发送中断。拖动手势用于选择文本，不再传给鼠标模式下的 TUI。

粘贴文本时，Windows / Linux 使用 Ctrl+V，macOS 使用 Command+V；浏览器将本地剪贴板文本发送到终端，遵循终端的括号粘贴模式。终端字节流不会自动携带浏览器剪贴板中的图片；远端 Codex 的图片粘贴快捷键读取的是节点本地剪贴板，可能无法访问浏览器设备的图片。

已有终端在升级 Agent 后的下一次附着时幂等应用滚动配置，不重建进程。前端构建保留 xterm 固定版本渲染补丁，修复末列文字截断；升级后刷新浏览器以载入新资源。

## 断开、终止与撤销节点

关闭页面或终端视图只断开该连接。明确终止会停止专属 systemd 单元和通常的后台子进程；节点离线时先保存终止意图，待重新上线执行。

需要手动恢复现存画面时，以原会话账户执行：

```sh
tmux -L workdeck-TERMINAL_ID attach-session -t main
```

手动停止某个终端：

```sh
systemctl --user stop workdeck-session-TERMINAL_ID.service
# root 创建的终端改用 sudo systemctl stop ...
```

撤销节点身份会关闭管理访问，保留节点本地任务。重新登记新身份会产生新节点 ID，旧终端不会自动迁移。不要为排障直接删除身份或会话目录。

## 自动选择传输链路

终端头部显示“直连”或“中转”；网络条同时显示 WebSocket / WebRTC RTT，并以“当前”标记实际承载数据的路径。展开后可查看路径示意、延迟差异、抖动、探测超时及各路径的数据累计量。

两条可用路径每五秒探测一次，即使其中一条暂不传终端数据。速率约每秒刷新，来自当前连接的终端输入输出，不包含信令、探测和协议开销，重连后重新累计。它既不是网络接口总带宽，也不是容量测试；探测超时不是 IP 丢包率。

终端始终先走中转。直连表现合适时绕开 Hub 传送终端字节；失败后回退中转，终端程序不重启。Hub 所在机器本身作为计算节点时，直连仍占用该机器的公网连接；其他节点直连才会减少 Hub 的终端中转流量。

可通过 Agent 的 systemd 覆盖配置调整：

```ini
[Service]
# 完全禁止本节点协商直连。
Environment=WORKDECK_DIRECT=0
# 或指定逗号分隔的 STUN 地址；显式留空则禁用外部 STUN。
Environment=WORKDECK_STUN_URLS=stun:stun.example.com:3478
# 文件上传和下载在同一系统账户内共享的总速率上限，单位为字节/秒。
Environment=WORKDECK_FILE_RATE_BYTES_PER_SEC=8388608
```

默认使用 `stun:stun.cloudflare.com:3478` 发现地址，STUN 不传送终端内容。受限 NAT、UDP 不通、STUN 不可达均会回退，不需要因此放开大范围入站端口。未配置 TURN。地址候选和 SDP 含网络拓扑信息，避免公开日志。支持增量候选交换的浏览器页面与节点会通过已认证的 WebSocket 信令逐个交换 ICE 候选，并在收到应答后单独计时连接检查；旧版节点或旧页面仍使用兼容的完整 SDP 协商。中转链路保持授权有效，不因直连失败关闭终端。

诊断时可使用 `?transport=relay` 打开页面，关闭该页面的直连探测。修改配置后只需重启 Agent。

终端的网络详情中可展开“直连诊断”，查看最近一次协商的阶段、候选类型、耗时、ICE 状态与候选对汇总计数。检测失败后仍可查看；若处于冷却或不可用状态，可点击“重新检测直连”重新连接当前浏览器终端，节点上的终端和任务不会因此关闭。复制诊断摘要后可以分享用于排障。摘要在当前标签页的 sessionStorage 中保存，刷新后可恢复，关闭标签页后由浏览器清除；不会上传到服务器。摘要只保留经过筛选的状态和计数，不包含 IP 地址、端口、原始 SDP、认证凭据或终端内容。浏览器不提供的统计显示为未记录，候选对请求与响应是按类型汇总的统计，不能单凭它们断定具体防火墙规则或丢包原因。新版节点应页面请求发送脱敏的节点侧采样，包括收集状态、配置的 STUN 数量、双方候选类型、增量候选接收与应用结果，以及逐条候选对的计数；旧节点不会发送该部分。节点采样时间从发送应答后开始，最新样本可能早于浏览器失败时间。仅配置 STUN 或未出现 srflx 不足以判断 STUN 是否可达。节点和浏览器之间没有导出用于一一关联候选对或 STUN 事务的标识，不能仅凭类型将两侧候选对视为同一条链路。诊断经现有认证的 WebSocket 传到当前浏览器，仅保存白名单字段，不保存节点候选地址、端口、SDP、候选 ID、STUN URL 或终端内容。

文件速率默认每个系统账户 8 MiB/s，允许设置为 262144 至 1073741824 字节/秒。同一账户的多个工作区、浏览器及上传和下载共用额度，中转与文件直连均受限；终端数据与文件控制消息不计入该额度。限速是节点侧的应用数据控制，不等同于网络接口总带宽限制。无效配置会阻止 Agent 启动，修改后按上述方式重启 Agent 生效；独立运行的终端任务不会因此关闭。

浏览器有当前会话终端的有效探测数据时，会在其实际链路延迟持续升高或多次超时后，逐步增加当前会话文件块之间的间隔；延迟持续恢复后逐步取消间隔。文件区显示“终端优先”表示该浏览器正在让出传输机会。短暂波动不会立即触发，探测过期或终端连接重建时不沿用旧测量。此调节只影响当前浏览器中该会话的文件连接；其他设备及交给浏览器下载管理器的兼容下载仍受节点固定限速，但不受该浏览器的延迟调节。它不保证所有网络环境下的交互延迟。

## 重启恢复与持久登录

工作区文件树上方的“更换工作区目录”可以选择新的根目录；它不会改变终端 Shell 的当前目录或停止任务。切换前请保存或处理当前浏览器里的草稿、待确认文件操作及正在进行的传输。其他设备仍可能持有未保存内容：切换后旧修订草稿会在这些设备的文件树中列出，供用户导出，不会自动写入新目录。目录浏览按节点服务账户展示，最终访问由终端实际账户核验。

其他设备遗留的旧修订文件操作会列在“旧目录的待确认操作”中。新版节点可只读查询原操作日志，删除操作可分页查看明细；查询不会重放或修改文件。节点没有记录、结果过期或内容不匹配时，应检查原目录，不能据此认定操作未执行。可导出本地记录，核对后手动确认移除；此操作只清理该浏览器中的记录。旧版本节点需升级后才能查询，原记录仍可导出。

Hub 从持久卷恢复节点、终端与登录记录。节点重连前先显示离线及上次观测状态；新的完整清单更新实际状态。Agent 用节点启动标识区分系统重启和网络重连。

Docker 的自动重启策略与普通用户的 lingering 使服务开机自动启动。Hub / Agent 服务重启保留独立终端；操作系统重启会结束其本机进程。页面重新创建操作打开新 Shell，不重跑原任务。

每台设备获得独立 HttpOnly 持久 Cookie，默认 30 天有效，活跃使用时续期。`.env` 中的 `WORKDECK_SESSION_TTL` 对应 Hub 的 `--session-ttl`，例如 `720h`。正常浏览器关闭后重开同一配置文件可保留登录；隐私模式、清除 Cookie、过期或主动退出会要求重新登录。

其他设备登录不影响已有设备。退出只影响当前设备，改密会主动撤销其他设备登录。登录凭证不放在 JavaScript localStorage。

## 服务账户与 root 节点

创建 Agent 服务时的账户决定新终端账户。root 安装 `/etc/systemd/system/workdeck-agent.service`，普通用户安装 `~/.config/systemd/user/workdeck-agent.service`。root 使用系统级命令，普通用户使用 `--user` 并启用 lingering。

变更账户时保留节点 ID、身份、原始会话账户和作用域。root Agent 能管理以前由普通用户创建的会话；在这些任务结束前，勿关闭原用户的 lingering 管理器。提升为 root 时应把签名私钥轮换到 root 专属目录，防止原账户继续持有 root 节点的认证能力。这类迁移需先做好私有备份。

## 节点名称与密码规则

节点详情中的重命名仅修改展示名称，支持离线操作，不改变身份和终端归属。终端也可独立重命名。

初始密码和新密码至少六个 Unicode 字符，必须包含 ASCII 字母与数字，大小写不限，无密码专用最大长度限制；统一 JSON 请求体大小上限仍然适用。已有旧密码仍可登录，部署不会主动修改密码。新密码采用 PBKDF2，仍兼容旧 bcrypt。跨密码格式版本回滚时需匹配数据库备份。

## 当前边界

单管理员、单 Hub；Agent 支持 Linux + systemd。尚无多租户隔离、原生 Windows Agent、进程检查点、完整录像导出或高可用。tmux 画面和历史在内存，管理元数据在磁盘。
