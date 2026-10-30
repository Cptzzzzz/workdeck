# 从节点接入指南

## 准备条件

- Linux amd64 或 arm64，已安装 `curl`、`tmux`，并有可用的用户级 systemd。
- 能主动访问 Hub 的 HTTPS/WSS 443 端口；无需公网 IP，也不用在从节点开放入站端口。
- 使用日常工作用户安装，**不要使用 root**。终端可以访问该用户的文件和已有工具凭证。

在 Debian / Ubuntu 上安装 tmux：

```sh
sudo apt update
sudo apt install -y tmux curl
systemctl --user show-environment >/dev/null
```

## 推荐方式：工作台生成接入命令

1. 登录自己的 Hub 页面，点击左侧“接入新节点”。
2. 点击“生成接入命令”，获得一个 10 分钟有效的令牌。
3. 在目标机器以工作用户执行界面生成的命令。示例使用占位域名和令牌：

```sh
curl -fsS https://work.example.com/install-agent.sh -o /tmp/workdeck-install.sh
sh /tmp/workdeck-install.sh \
  --hub https://work.example.com \
  --token YOUR_ONE_TIME_TOKEN \
  --name worker-01
```

不要把示例 token 原样使用，也不要公开真实的接入命令。省略 `--name` 时默认使用目标机器的主机名。名称会保存在 Hub 中，应避免使用不希望暴露的个人信息。

安装器会识别架构、下载并校验 Agent、登记节点身份，创建并启动用户级 `workdeck-agent.service`。身份已存在时安装器会停止，不会覆盖旧身份；普通重启不需要重新接入。

4. 为了让退出 SSH 后会话继续运行，并在主机开机后自动启动用户服务，执行：

```sh
sudo loginctl enable-linger "$(id -un)"
```

5. 检查状态，回到页面等待节点显示在线：

```sh
systemctl --user status workdeck-agent --no-pager
systemctl --user is-enabled workdeck-agent
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

`agent run` 是前台运行模式；如需退出登录后持续运行，应配置仓库中的用户服务模板，并按实际用户调整路径与 Shell，随后执行：

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

Hub 和 Agent 可以部署在同一台机器上：Hub 继续负责管理与转发，普通系统用户运行的 Agent 负责终端任务。它使用相同的接入令牌流程，接入后会出现在“计算节点”列表中，可以直接选择它创建终端。

在主服务机器上创建或选择一个普通工作用户，使用该用户执行上面的安装步骤，并启用 linger。建议给节点设置容易识别的名字，例如 `hub-worker`。工作目录和可访问文件由该用户的操作系统权限决定。

Hub 的 Docker 服务设置为自动启动，Agent 使用用户级 systemd 自启动；两者的持久数据目录需要保留。重装或升级程序时不要清空数据库、Agent 身份或会话记录目录。
