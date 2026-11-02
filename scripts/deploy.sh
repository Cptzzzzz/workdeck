#!/bin/sh
# Build locally first: scripts/build.sh
set -eu
ssh() {
  # Remote scripts arrive on stdin. Retrying this stream after a failure may
  # send EOF and falsely report success even though the script did not run.
  command ssh -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 "$@"
}
cd "$(dirname "$0")/.."
config="${WORKDECK_DEPLOY_CONFIG:-./.env.deploy.local}"
if [ -f "$config" ]; then
  # This is a local, trusted shell configuration; never source files from an untrusted source.
  set -a
  . "$config"
  set +a
fi
: "${WORKDECK_SSH_TARGET:?Copy .env.deploy.example to .env.deploy.local and set WORKDECK_SSH_TARGET}"
: "${WORKDECK_PUBLIC_URL:?Set WORKDECK_PUBLIC_URL}"
: "${WORKDECK_DOCKER_NETWORK:?Set WORKDECK_DOCKER_NETWORK}"
: "${WORKDECK_CADDY_DIR:?Set WORKDECK_CADDY_DIR}"
server="$WORKDECK_SSH_TARGET"
public_url="${WORKDECK_PUBLIC_URL%/}"
deploy_dir="${WORKDECK_DEPLOY_DIR:-/opt/stacks/workdeck}"
network="$WORKDECK_DOCKER_NETWORK"
caddy_dir="$WORKDECK_CADDY_DIR"
caddy_container="${WORKDECK_CADDY_CONTAINER:-caddy}"
cidr="${WORKDECK_TRUSTED_PROXY_CIDR:-}"
session_ttl="${WORKDECK_SESSION_TTL:-720h}"
tailnet_probe_url="${WORKDECK_TAILNET_PROBE_URL:-}"
tailnet_probe_disable="${WORKDECK_TAILNET_PROBE_DISABLE:-0}"
case "$public_url" in https://*) domain="${public_url#https://}";; *) echo 'An HTTPS public URL is required' >&2; exit 1;; esac
case "$domain" in ''|*[!a-zA-Z0-9.-]*|.*|*.) echo 'Use a hostname without paths or ports in WORKDECK_PUBLIC_URL' >&2; exit 1;; esac
case "$server" in ''|*[!a-zA-Z0-9_.@:-]*) echo 'Invalid SSH target' >&2; exit 1;; esac
for path in "$deploy_dir" "$caddy_dir"; do
  case "$path" in /*) ;; *) echo 'Deployment paths must be absolute' >&2; exit 1;; esac
  case "$path" in *[!a-zA-Z0-9_/.-]*) echo 'Deployment paths must not contain whitespace or shell characters' >&2; exit 1;; esac
done
for name in "$network" "$caddy_container"; do
  case "$name" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid Docker network or container name' >&2; exit 1;; esac
done
case "$cidr" in *[!a-fA-F0-9.:/]*) echo 'Invalid proxy CIDR' >&2; exit 1;; esac
case "$session_ttl" in ''|*[!0-9hms.]*) echo 'Invalid session lifetime' >&2; exit 1;; esac
case "$tailnet_probe_disable" in 0|1) ;; *) echo 'Invalid Tailnet probe disable flag' >&2; exit 1;; esac
if [ -n "$tailnet_probe_url" ]; then
  case "$tailnet_probe_url" in https://*/probe) ;; *) echo 'Tailnet probe URL must use HTTPS and end in /probe' >&2; exit 1;; esac
  case "$tailnet_probe_url" in *[!a-zA-Z0-9:./-]*) echo 'Invalid Tailnet probe URL characters' >&2; exit 1;; esac
  [ "$tailnet_probe_disable" = 0 ] || { echo 'Cannot enable and disable the Tailnet probe together' >&2; exit 1; }
fi
version="$(cat bin/VERSION)"
case "$version" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid build version' >&2; exit 1;; esac
[ -f bin/workdeck-linux-amd64 ] && [ -f web/dist/index.html ] || { echo 'Run scripts/build.sh first' >&2; exit 1; }
cp /etc/ssl/certs/ca-certificates.crt deploy/ca-certificates.crt
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT HUP INT TERM
tar -czf "$archive" bin/workdeck-linux-amd64 web/dist deploy/Dockerfile deploy/ca-certificates.crt deploy/compose.yml deploy/compose.tailnet.yml deploy/Caddyfile.snippet LICENSE THIRD_PARTY_NOTICES.md third_party
ssh "$server" sh -s -- "$deploy_dir" <<'REMOTE'
set -eu
root="$1"
install -d -m 700 "$root" "$root/secrets" "$root/backups"
mkdir -p "$root/build" "$root/data"
chown 65532:65532 "$root/data"
REMOTE
rsync -az --partial --timeout=60 -e "ssh -o ConnectTimeout=10 -o ServerAliveInterval=15" "$archive" "$server:$deploy_dir/release.tar.gz"
if ! ssh "$server" "test -f $deploy_dir/secrets/admin_password"; then
  [ -f .secrets/administrator.txt ] || { echo 'Create your initial password in .secrets/administrator.txt first' >&2; exit 1; }
  rsync -az --timeout=60 .secrets/administrator.txt "$server:$deploy_dir/secrets/admin_password"
  ssh "$server" "chown 65532:65532 $deploy_dir/secrets/admin_password; chmod 400 $deploy_dir/secrets/admin_password"
fi
# SSH joins remote arguments through a shell, which drops empty arguments.
# Encode optional values so positional parameters remain stable remotely.
remote_cidr="${cidr:--}"
remote_tailnet_probe_url="${tailnet_probe_url:--}"
ssh "$server" sh -s -- "$version" "$deploy_dir" "$public_url" "$network" "$remote_cidr" "$caddy_dir" "$caddy_container" "$domain" "$session_ttl" "$remote_tailnet_probe_url" "$tailnet_probe_disable" <<'REMOTE'
set -eu
version="$1"; root="$2"; public_url="$3"; network="$4"; cidr="$5"; caddy_dir="$6"; caddy_container="$7"; domain="$8"; session_ttl="$9"
tailnet_probe_url="${10}"; tailnet_probe_disable="${11}"
[ "$cidr" != - ] || cidr=''
[ "$tailnet_probe_url" != - ] || tailnet_probe_url=''
cd "$root"
if [ -f .env ] && grep -q '^WORKDECK_TAILNET_PROBE_URL=.' .env && [ -z "$tailnet_probe_url" ] && [ "$tailnet_probe_disable" != 1 ]; then
  echo 'Tailnet probe is enabled remotely; set WORKDECK_TAILNET_PROBE_URL or explicitly set WORKDECK_TAILNET_PROBE_DISABLE=1.' >&2
  exit 1
fi
if [ -n "$tailnet_probe_url" ]; then
  [ -f secrets/tailnet_probe_secret ] && [ ! -L secrets/tailnet_probe_secret ] || { echo 'Tailnet probe secret file is missing or unsafe.' >&2; exit 1; }
  probe_mode="$(stat -c %a secrets/tailnet_probe_secret)"
  probe_size="$(wc -c < secrets/tailnet_probe_secret)"
  [ "$(stat -c %u secrets/tailnet_probe_secret)" = 65532 ] && [ $((0$probe_mode & 077)) = 0 ] && [ $((0$probe_mode & 0400)) != 0 ] && [ "$probe_size" -ge 32 ] && [ "$probe_size" -le 4096 ] || { echo 'Tailnet probe secret must be 32–4096 bytes, readable by UID 65532 and private.' >&2; exit 1; }
fi
tar -xzf release.tar.gz -C build
cp build/deploy/compose.yml compose.yml
cp build/deploy/compose.tailnet.yml compose.tailnet.yml
if [ -f .env ]; then cp .env "backups/env-$(date +%Y%m%d-%H%M%S)"; fi
printf 'WORKDECK_VERSION=%s\nWORKDECK_PUBLIC_URL=%s\nWORKDECK_DOCKER_NETWORK=%s\nWORKDECK_TRUSTED_PROXY_CIDR=%s\nWORKDECK_SESSION_TTL=%s\n' "$version" "$public_url" "$network" "$cidr" "$session_ttl" > .env
if [ -n "$tailnet_probe_url" ]; then printf 'WORKDECK_TAILNET_PROBE_URL=%s\n' "$tailnet_probe_url" >> .env; fi
docker build -f build/deploy/Dockerfile -t "workdeck:$version" build
if [ -n "$tailnet_probe_url" ]; then
  docker compose -f compose.yml -f compose.tailnet.yml config --quiet
  docker compose -f compose.yml -f compose.tailnet.yml up -d
else
  docker compose config --quiet
  docker compose up -d
fi
if ! grep -Fq "$domain {" "$caddy_dir/Caddyfile"; then
  cp "$caddy_dir/Caddyfile" "backups/Caddyfile-$(date +%Y%m%d-%H%M%S)"
  cp "$caddy_dir/Caddyfile" "$caddy_dir/Caddyfile.workdeck-candidate"
  printf '\n' >> "$caddy_dir/Caddyfile.workdeck-candidate"
  sed "s/__WORKDECK_DOMAIN__/$domain/g" build/deploy/Caddyfile.snippet >> "$caddy_dir/Caddyfile.workdeck-candidate"
  docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile.workdeck-candidate --adapter caddyfile
  mv "$caddy_dir/Caddyfile.workdeck-candidate" "$caddy_dir/Caddyfile"
  docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
docker compose ps
REMOTE
printf '\nDeployed %s to %s\n' "$version" "$public_url"
