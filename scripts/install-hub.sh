#!/bin/sh
# 单机部署入口：独立 Caddy HTTPS、已有反向代理、仅本机验证。
set -eu
umask 077
install_dir=/opt/workdeck
domain=''
mode=''
port=''
project=''
source_dir=''
go_proxy=''
ref=main
usage() {
  cat <<'HELP'
用法：sh install-hub.sh --domain work.example.com [选项]
  --domain 域名   公开 HTTPS 域名，需提前完成 DNS 解析
  --dir 目录      安装目录，默认 /opt/workdeck
  --proxy         使用已有反向代理，仅监听本机端口
  --local         仅本机 HTTP 验证，无需域名和 Caddy
  --port 端口     本机监听端口，默认 8090
  --project 名称  Compose 项目名，默认 workdeck-standalone
  --ref 引用      Git 标签、分支或提交，默认 main
  --source 目录   从本地源码构建，省略时下载 GitHub 源码
  --go-proxy URL  Go 依赖代理，例如 https://goproxy.cn,direct
重复执行会保留数据库、证书、初始密码和已保存的域名/模式。
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0;;
    --proxy) mode=proxy; shift;;
    --local) mode=local; shift;;
    --domain|--dir|--port|--project|--ref|--source|--go-proxy)
      [ "$#" -ge 2 ] || { echo "缺少参数：$1" >&2; exit 1; }
      case "$1" in
        --domain) domain="$2";; --dir) install_dir="$2";;
        --port) port="$2";; --project) project="$2";;
        --ref) ref="$2";; --source) source_dir="$2";;
        --go-proxy) go_proxy="$2";;
      esac
      shift 2;;
    *) echo "未知选项：$1" >&2; usage >&2; exit 1;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo 'Hub 安装器目前支持 Linux。' >&2; exit 1; }
case "$install_dir" in /*) ;; *) echo '安装目录必须是绝对路径。' >&2; exit 1;; esac
case "$install_dir" in /|*/../*|*/..|*/./*|*/.|*[!a-zA-Z0-9_./-]*) echo '安装目录包含不支持的字符。' >&2; exit 1;; esac
command -v docker >/dev/null || { echo '请先安装 Docker Engine 和 Compose 插件。' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '当前账户无法访问 Docker 服务。' >&2; exit 1; }
docker compose version >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
if [ -d "$install_dir" ] && [ -n "$(ls -A "$install_dir")" ] && [ ! -f "$install_dir/.workdeck-install" ]; then
  echo '目标目录已有其他内容，请选择一个新的空目录。' >&2; exit 1
fi
mkdir -p "$install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
[ "$install_dir" != / ] || { echo '不能使用根目录。' >&2; exit 1; }
# 仅读取生成的单行值，不把 .env 当作 Shell 程序执行。
saved() { sed -n "s/^$1=//p" "$install_dir/.env" 2>/dev/null | head -n 1; }
[ -n "$domain" ] || domain="$(saved WORKDECK_DOMAIN)"
[ -n "$mode" ] || mode="$(saved WORKDECK_MODE)"
[ -n "$port" ] || port="$(saved WORKDECK_PORT)"
[ -n "$project" ] || project="$(saved WORKDECK_PROJECT)"
[ -n "$go_proxy" ] || go_proxy="$(saved WORKDECK_GO_PROXY)"
go_proxy="${go_proxy:-https://proxy.golang.org,direct}"
case "$go_proxy" in *[!a-zA-Z0-9_:/.,-]*) echo 'Go 代理地址包含不支持的字符。' >&2; exit 1;; esac
mode="${mode:-https}"; port="${port:-8090}"; project="${project:-workdeck-standalone}"
case "$mode" in https|proxy|local) ;; *) echo '无效的部署模式。' >&2; exit 1;; esac
case "$port" in ''|*[!0-9]*) echo '端口必须是整数。' >&2; exit 1;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { echo '端口需在 1–65535 之间。' >&2; exit 1; }
case "$project" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) echo '无效的 Compose 项目名。' >&2; exit 1;; esac
case "$ref" in ''|*[!a-zA-Z0-9_./-]*|*..*) echo '无效的源码引用。' >&2; exit 1;; esac
if [ "$mode" = local ]; then
  public_url="http://127.0.0.1:$port"
  domain=localhost
else
  case "$domain" in ''|*[!a-zA-Z0-9.-]*|.*|*.|*..*|-*|*-) echo '请提供有效域名，例如 --domain work.example.com。' >&2; exit 1;; esac
  domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
  public_url="https://$domain"
fi
# 不接管同名的其他 Compose 项目，不操作它们的容器或配置。
for container in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
  owner="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")"
  [ "$owner" = "$install_dir" ] || { echo "Compose 项目 $project 已被其他目录使用；请更换 --project。" >&2; exit 1; }
done
chmod 700 "$install_dir"
# 同一目录安装互斥；退出时释放锁，避免两次安装覆盖彼此。
mkdir "$install_dir/.install-lock" 2>/dev/null || { echo "已有安装进行中；若上次进程异常退出，请检查后移除 $install_dir/.install-lock。" >&2; exit 1; }
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"; rmdir "$install_dir/.install-lock"' EXIT
trap 'exit 1' HUP INT TERM
touch "$install_dir/.workdeck-install"
mkdir "$tmp_dir/source"
if [ -n "$source_dir" ]; then
  source_dir="$(cd "$source_dir" && pwd -P)"
  # 明确复制构建所需目录，排除身份、数据库、日志和本地部署文件。
  tar -C "$source_dir" --exclude=node_modules --exclude=dist --exclude=test-results \
    --exclude=web/public/downloads --exclude=web/public/install-agent.sh \
    -cf "$tmp_dir/source.tar" Dockerfile .dockerignore go.mod go.sum LICENSE \
    THIRD_PARTY_NOTICES.md third_party cmd internal scripts web deploy/standalone
  tar -xf "$tmp_dir/source.tar" -C "$tmp_dir/source"
  version="$(git -C "$source_dir" rev-parse --short HEAD 2>/dev/null || printf local)"
else
  curl --fail --show-error --location --connect-timeout 15 --max-time 300 --retry 3 \
    "https://api.github.com/repos/Cptzzzzz/workdeck/tarball/$ref" -o "$tmp_dir/source.tar.gz"
  archive_root="$(tar -tzf "$tmp_dir/source.tar.gz" | head -n 1)"
  version="${archive_root%/}"
  version="${version##*-}"
  case "$version" in ''|*[!a-fA-F0-9]*) echo '无法识别源码快照版本。' >&2; exit 1;; esac
  tar -xzf "$tmp_dir/source.tar.gz" --strip-components=1 -C "$tmp_dir/source"
fi
# 使用源码中相同版本的 Compose 文件，配置和数据始终留在源码目录之外。
[ -f "$tmp_dir/source/Dockerfile" ] && [ -f "$tmp_dir/source/deploy/standalone/compose.yml" ]
mkdir -p "$install_dir/secrets"
chmod 700 "$install_dir/secrets"
if [ ! -f "$install_dir/secrets/admin_password" ]; then
  printf 'Wd6' > "$install_dir/secrets/admin_password"
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n' >> "$install_dir/secrets/admin_password"
  printf '\n' >> "$install_dir/secrets/admin_password"
fi
# 宿主机目录仅安装用户可访问；绑定进容器后，非 root Hub 可读取该文件。
chmod 444 "$install_dir/secrets/admin_password"
if [ "$(id -u)" = 0 ]; then
  chown 65532:65532 "$install_dir/secrets/admin_password"
  chmod 400 "$install_dir/secrets/admin_password"
fi
session_ttl="$(saved WORKDECK_SESSION_TTL)"
proxy_cidr="$(saved WORKDECK_TRUSTED_PROXY_CIDR)"
session_ttl="${session_ttl:-720h}"
case "$session_ttl" in *[!0-9hms.]*) echo '已保存的登录有效期无效。' >&2; exit 1;; esac
case "$proxy_cidr" in *[!a-fA-F0-9.:/]*) echo '已保存的代理网段无效。' >&2; exit 1;; esac
[ ! -f "$install_dir/.env" ] || cp "$install_dir/.env" "$install_dir/.env.previous"
cat > "$install_dir/.env" <<CONFIG
WORKDECK_PROJECT=$project
WORKDECK_MODE=$mode
WORKDECK_DOMAIN=$domain
WORKDECK_PUBLIC_URL=$public_url
WORKDECK_PORT=$port
WORKDECK_VERSION=$version
WORKDECK_IMAGE=$project:local
WORKDECK_SESSION_TTL=$session_ttl
WORKDECK_TRUSTED_PROXY_CIDR=$proxy_cidr
WORKDECK_GO_PROXY=$go_proxy
CONFIG
cp "$tmp_dir/source/deploy/standalone/compose.yml" "$install_dir/compose.yml"
cp "$tmp_dir/source/deploy/standalone/Caddyfile" "$install_dir/Caddyfile"
# 只替换本安装器管理的源码快照；运行数据不在这个目录内。
if [ -e "$install_dir/source" ]; then mv "$install_dir/source" "$tmp_dir/previous-source"; fi
mv "$tmp_dir/source" "$install_dir/source"
cd "$install_dir"
docker compose config --quiet
docker compose build hub
if [ "$mode" = https ]; then
  docker compose --profile https up -d
else
  # 切换为代理/本机模式时只关闭本项目的 Caddy。
  docker compose --profile https stop caddy
  docker compose up -d hub
fi
attempt=0
until curl --noproxy '*' --connect-timeout 2 --max-time 3 --fail --silent "http://127.0.0.1:$port/healthz" >/dev/null; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ] || { echo "Hub 健康检查失败，请运行：cd $install_dir && docker compose logs --tail 100 hub" >&2; exit 1; }
  sleep 1
done
printf '\nWorkdeck 已启动：%s\n账户：admin\n初始密码文件：%s/secrets/admin_password\n安装目录：%s\n' "$public_url" "$install_dir" "$install_dir"
if [ "$mode" = https ]; then
  echo 'Caddy 将自动申请 HTTPS 证书；请确保域名解析和入站 80/443 已就绪。'
elif [ "$mode" = proxy ]; then
  printf '请将已有反向代理指向 127.0.0.1:%s，并启用 WebSocket 转发。\n' "$port"
fi
echo '登录后在“接入新节点”中生成计算节点安装命令。升级时重复执行安装命令即可。'
