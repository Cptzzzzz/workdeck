# 部署指南

## 选择部署方式

| 场景 | 推荐方式 |
| --- | --- |
| 新服务器，有空闲 80 / 443 | 一键安装 Hub + 独立 Caddy |
| 已有 Nginx、Caddy 或其他反向代理 | 一键安装加 `--proxy`，自行配置代理 |
| 已有 Caddy 容器和共享 Docker 网络 | 使用下文保留的远程部署脚本 |
| 开发或隔离验收 | 一键安装加 `--local`，仅绑定本机 HTTP |

Hub 支持 Linux amd64 / arm64。计算节点额外要求 tmux 和可用的 systemd，可安装在 Hub 宿主机。Hub 容器无需 systemd，也不直接托管计算任务。

## 一键安装独立 HTTPS 服务

先安装 Docker Engine、Compose v2、curl、tar。安装命令需要当前账户能访问 Docker，且能写入目标目录；默认 `/opt/workdeck` 通常需要 root。

将自己的域名解析到服务器，保证 TCP 80 / 443 可以访问且未被其他服务占用，然后执行：

```sh
curl -fsSL https://raw.githubusercontent.com/Cptzzzzz/workdeck/main/scripts/install-hub.sh \
  | sudo sh -s -- --domain work.example.com
```

安装器下载 GitHub 源码，在 Docker 中构建 Go 服务、两个架构的 Agent 和前端，再启动独立 Compose 项目。Caddy 自动申请和续期证书。首次构建需要访问 GitHub、Docker 镜像仓库、Go 和 npm 依赖源。

默认位置与数据：

```text
/opt/workdeck/
  .env                    非公开的部署参数
  compose.yml             本部署的服务定义
  Caddyfile               本部署的 HTTPS 代理配置
  source/                 可替换的源码快照，不存运行数据
  secrets/admin_password  初始管理员密码
```

SQLite 使用项目的 `hub-data` 命名卷；证书保存在 `caddy-data`、`caddy-config` 命名卷。宿主机目录仅安装账户可访问，Hub 在容器内使用 UID/GID 65532 运行。不要执行 `docker compose down -v`，该选项会删除这些持久卷。

初始用户名 `admin`，密码读取方式：

```sh
sudo cat /opt/workdeck/secrets/admin_password
```

界面改密后，数据库中的密码哈希生效，初始化文件不再代表当前密码；重复安装不会重置密码。

### 已有反向代理

```sh
curl -fsSL https://raw.githubusercontent.com/Cptzzzzz/workdeck/main/scripts/install-hub.sh \
  | sudo sh -s -- --domain work.example.com --proxy --port 8090
```

该模式只启动 Hub，监听 `127.0.0.1:8090`。将现有代理指向这个地址，允许 WebSocket 升级及持续连接，并通过 HTTPS 提供相同的公开域名。宿主机运行的 Caddy 示例：

```caddyfile
work.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

容器中的代理不能把自己的 `127.0.0.1` 当作宿主机。已有 Caddy 容器建议使用本文的共享网络方案，或由运维配置可访问的宿主机地址。

按实际代理来源网段设置 `.env` 中的 `WORKDECK_TRUSTED_PROXY_CIDR`，用于正确区分登录限流的客户端地址。不要信任任意来源的转发头。

### 本机试用与源码安装

```sh
# 仅本机 HTTP，不启动 Caddy。远程浏览器可使用 SSH 本地端口转发访问。
sh scripts/install-hub.sh --local --port 18090 \
  --dir "$PWD/.secrets/local-deployment" --project workdeck-local --source "$PWD"
```

`--source` 从本地工作树复制构建所需源码，排除运行目录和常见生成目录。不要把包含敏感内容的文件放进源码目录。默认不传 `--source` 时使用 GitHub 源码快照。

`--dir` 必须使用绝对路径，目标应为空目录或安装器已经管理的目录。`--project` 默认 `workdeck-standalone`；不同实例应使用不同项目名、目录和本机端口。安装器会拒绝接管其他目录创建的同名 Compose 项目。

## 升级、版本选择与回滚

重复执行原安装命令会更新源码并重建，保留已保存的域名、模式、端口、会话有效期及代理网段。`--ref` 可以指定 Git 标签、分支或提交：

```sh
# 固定版本时，将 RELEASE_TAG 换成确实存在的标签或提交。
curl -fsSL https://raw.githubusercontent.com/Cptzzzzz/workdeck/main/scripts/install-hub.sh \
  | sudo sh -s -- --ref RELEASE_TAG
```

Hub 更新会短暂断开浏览器，节点上的 tmux 任务继续运行。Agent 升级独立进行，见运维手册。源码编译失败时现有容器继续运行；检查安装输出，修复下载或构建问题后重试。

回滚前备份数据库和参数。数据库或密码哈希格式不一定向后兼容，尤其是旧版不支持新版 PBKDF2 格式时，需恢复对应数据库备份。不要只回滚可执行文件就假设数据必然兼容。

## 保留方案：已有 Caddy 的远程部署

仓库保留 `scripts/build.sh` 和 `scripts/deploy.sh`，适合已有 Caddy 容器及共享 Docker 网络的服务器。此方案当前 Hub 镜像目标为 Linux amd64；Agent 同时提供 amd64 / arm64。

本地需要 Go 1.25+、Node.js 22+、SSH、rsync、tar。服务器需要 Docker Compose、现有 Caddy 容器、共享网络，以及挂载到 Caddy 容器 `/etc/caddy` 的配置目录。

```sh
cp .env.deploy.example .env.deploy.local
chmod 600 .env.deploy.local
# 编辑 .env.deploy.local，填入自己的 SSH、域名、Caddy 目录和网络。
mkdir -p .secrets
chmod 700 .secrets
# 将符合规则的初始密码写入此文件，不要提交。
printf 'Wd6' > .secrets/administrator.txt
openssl rand -hex 24 >> .secrets/administrator.txt
chmod 600 .secrets/administrator.txt
scripts/build.sh
scripts/deploy.sh
```

这个私有配置文件按受信任 Shell 配置读取，不要执行不可信来源提供的文件。公开 `.env.deploy.example` 只包含示例。

脚本在远程创建独立的 Workdeck Compose 栈，加入现有网络，不开放新宿主机端口。域名尚未配置时，会备份 Caddyfile、验证候选配置再重载 Caddy；不会重建其他应用。已有站点块交由运维自行管理，不自动覆盖。

默认远程目录 `/opt/stacks/workdeck`，可配置：

```text
compose.yml              服务定义
.env                     版本和部署参数
build/                   发布构建上下文
data/workdeck.db         SQLite 数据库
secrets/admin_password   初始化密码
backups/                 配置及入口备份
```

初始密码单独传输，不进入源码压缩包或镜像。Hub 使用非 root 用户、只读根文件系统、受限能力和有界日志。生产实例的私有参数始终留在 Git 忽略的本地文件中。

## 健康检查与后续步骤

```sh
curl -fsS https://work.example.com/healthz
cd /opt/workdeck
docker compose ps
docker compose logs --tail 100 hub
```

一键安装器会检查本机 Hub 健康；HTTPS 证书申请可能稍后完成，还需检查 DNS 和公网访问。登录后生成节点接入命令。主机作为计算节点时，也应在宿主机单独安装 Agent，而不是在 Hub 容器里启动 Shell。

详见 [节点接入](agent-setup.md)、[运维手册](operations.md)、[敏感信息清单](security.md)。

## 构建网络配置

若服务器无法访问默认 Go 依赖代理，可在首次安装或重试时指定可访问的代理：

```sh
curl -fsSL https://raw.githubusercontent.com/Cptzzzzz/workdeck/main/scripts/install-hub.sh \
  | sudo sh -s -- --domain work.example.com --go-proxy https://goproxy.cn,direct
```

该配置会保存到部署目录的私有 `.env`，后续升级继续使用。镜像构建仍会校验 Go 模块与 npm 锁文件，不关闭证书或完整性校验。若 GitHub、容器仓库或其他依赖源也受限，需要先配置服务器的网络访问；安装器不会接管系统代理或防火墙。
