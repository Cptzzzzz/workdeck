# 从节点接入指南

## 准备条件

- Linux amd64 或 arm64，已安装 `curl`、`tmux`，并有可用的 systemd。
- 能主动访问 Hub 的 HTTPS/WSS 443 端口；无需公网 IP，也不用在从节点开放入站端口。
- 终端默认先走中转，并在后台检测浏览器与节点能否直接通信。UDP 与 NAT 条件允许、且实际延迟和稳定性合适时会自动直连；否则继续中转，无需额外配置。外部 STUN 仅用于地址发现，可通过 Agent 环境变量关闭或替换，见 [运维说明](operations.md#automatic-terminal-transport-selection)。
- 使用希望终端实际运行的账户安装：root 创建系统服务，其他账户创建用户服务。新终端继承该服务账户，可以访问该账户的文件和已有工具凭证。

在 Debian / Ubuntu 上安装 tmux：

```sh
sudo apt update
sudo apt install -y tmux curl
# 普通用户安装时检查用户管理器；root 安装时使用 systemctl show-environment
systemctl --user show-environment >/dev/null
```

## 推荐方式：工作台生成接入命令

1. 登录自己的 Hub 页面，点击左侧“接入新节点”。
2. 点击“生成接入命令”，获得一个 10 分钟有效的令牌。
3. 在目标机器以所选服务账户执行界面生成的命令。示例使用占位域名和令牌：

```sh
curl -fsS https://work.example.com/install-agent.sh -o /tmp/workdeck-install.sh
sh /tmp/workdeck-install.sh \
  --hub https://work.example.com \
  --token YOUR_ONE_TIME_TOKEN \
  --name worker-01
```

不要把示例 token 原样使用，也不要公开真实的接入命令。省略 `--name` 时默认使用目标机器的主机名。名称会保存在 Hub 中，应避免使用不希望暴露的个人信息。

安装器会识别架构、下载并校验 Agent、登记节点身份，根据执行账户创建并启动系统级或用户级 `workdeck-agent.service`。身份已存在时安装器会停止，不会覆盖旧身份；普通重启不需要重新接入。

4. 普通用户安装时，为了让退出 SSH 后会话继续运行，并在主机开机后自动启动用户服务，执行（root 的系统服务不需要此步骤）：

```sh
sudo loginctl enable-linger "$(id -un)"
```

5. 检查状态，回到页面等待节点显示在线：

```sh
# 普通用户安装
systemctl --user status workdeck-agent --no-pager
systemctl --user is-enabled workdeck-agent
# root 安装则使用
sudo systemctl status workdeck-agent --no-pager
sudo systemctl is-enabled workdeck-agent
```

安装不需要重启已有终端或其他服务。节点上线后即可在页面选择该节点，创建终端并运行 Shell、Codex 等工具。

## 手动方式：已有 Agent 可执行文件

将对应架构的可信可执行文件放在 `~/.local/bin/workdeck`，并添加执行权限。把一次性 token 写入仅自己可读的文件，然后执行：

```sh
chmod 600 /path/to/join-token
~/.local/bin/workdeck agent enroll \
  --hub https://work.example.com \
  --name worker-01 \
  --token-file /path/to/join-token
~/.local/bin/workdeck agent run
```

通过 `--token-file` 可避免真实 token 出现在 Agent 的命令行参数中。输入 token 时也需避免把它写进共享 Shell 历史。接入完成后安全移除临时 token 文件。

`agent run` 是前台运行模式；如需退出登录后持续运行，普通用户使用仓库中的用户服务模板；root 使用 `deploy/workdeck-agent-root.service` 系统服务模板。按实际账户调整路径与 Shell。普通用户执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now workdeck-agent.service
```

## 常见问题

- **`Failed to connect to bus`**：当前环境没有可用的用户级 systemd 会话。通过正常用户 SSH 登录后检查；精简容器通常不满足此条件。
- **令牌失效或已使用**：在工作台生成新的令牌。Agent 若已有 `identity.json`，通常只需启动原有服务；不要直接删除身份或会话目录。
- **TLS 或节点认证失败**：检查域名、证书、节点系统时间和身份是否被撤销。节点签名有时间窗口，需要准确的系统时钟。
- **节点不在线**：检查出站 443、WebSocket 代理，以及 `journalctl --user -u workdeck-agent -n 100 --no-pager`。日志没有权限时咨询管理员，分享前先脱敏。
- **节点重新注册**：撤销身份和重新接入是两个操作。新身份对应新节点 ID，旧终端不会自动迁移；需要先保留好原记录。

浏览器关闭及 Hub/Agent 重启不会结束独立托管的终端；从节点断电或重启会丢失原运行进程。

## 主服务所在机器也作为计算节点

Hub 和 Agent 可以部署在同一台机器上。终端使用创建 Agent 服务时的系统账户：以 root 执行安装器，会创建 `User=root` 的系统服务；以普通用户执行，会创建该用户的用户服务。

在需要 root 终端的主服务机器上，以 root 执行接入命令，服务文件位于 `/etc/systemd/system/workdeck-agent.service`，数据默认位于 `/root/.local/share/workdeck/`。接入后，页面会显示节点的实际运行用户，可以选择该节点创建 root 终端。

更换服务账户时，应先备份并迁移原身份和会话记录，保持节点 ID。已有进程继续以原账户运行；新建终端使用新的服务账户。root Agent 能保留对迁移前普通用户会话的连接与管理能力，避免切换服务账户时中断已有工作。

更新和重启 root 服务：

```sh
systemctl restart workdeck-agent
systemctl status workdeck-agent --no-pager
```

Hub 的 Docker 服务和对应的 systemd Agent 服务均应设置为自动启动，并保留各自的数据目录。
