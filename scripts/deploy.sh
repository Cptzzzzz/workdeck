#!/bin/sh
# Build locally first: PATH=/path/to/go/bin:$PATH scripts/build.sh
set -eu
cd "$(dirname "$0")/.."
server="${WORKDECK_SSH_TARGET:-root@server.example.com}"
version="$(git rev-parse --short HEAD)"
[ -f bin/workdeck-linux-amd64 ] && [ -f web/dist/index.html ] || { echo 'Run scripts/build.sh first' >&2; exit 1; }
cp /etc/ssl/certs/ca-certificates.crt deploy/ca-certificates.crt
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT HUP INT TERM
tar -czf "$archive" bin/workdeck-linux-amd64 web/dist deploy/Dockerfile deploy/ca-certificates.crt deploy/compose.yml deploy/Caddyfile.snippet
ssh "$server" 'install -d -m 700 /opt/stacks/workdeck /opt/stacks/workdeck/secrets /opt/stacks/workdeck/backups; mkdir -p /opt/stacks/workdeck/build /opt/stacks/workdeck/data; chown 65532:65532 /opt/stacks/workdeck/data'
rsync -az --partial --timeout=60 -e "ssh -o ServerAliveInterval=15" "$archive" "$server:/opt/stacks/workdeck/release.tar.gz"
# Secrets are transferred as a separate file, never included in an image or source archive.
if ! ssh "$server" 'test -f /opt/stacks/workdeck/secrets/admin_password'; then
  [ -f .secrets/administrator.txt ] || { echo 'Create a 16+ character administrator password in .secrets/administrator.txt first' >&2; exit 1; }
  rsync -az --timeout=60 .secrets/administrator.txt "$server:/opt/stacks/workdeck/secrets/admin_password"
  ssh "$server" 'chown 65532:65532 /opt/stacks/workdeck/secrets/admin_password; chmod 400 /opt/stacks/workdeck/secrets/admin_password'
fi
ssh "$server" sh -s -- "$version" <<'REMOTE'
set -eu
version="$1"
cd /opt/stacks/workdeck
tar -xzf release.tar.gz -C build
cp build/deploy/compose.yml compose.yml
if [ -f .env ]; then cp .env "backups/env-$(date +%Y%m%d-%H%M%S)"; fi
printf 'WORKDECK_VERSION=%s\n' "$version" > .env
docker build -f build/deploy/Dockerfile -t "workdeck:$version" build
docker compose config --quiet
docker compose up -d
# Add only this hostname. Validate the complete candidate before reloading the existing Caddy.
caddy_dir=/opt/stacks/public-apps/caddy
if ! rg -q '^work\.cptz\.space[[:space:]]*\{' "$caddy_dir/Caddyfile" 2>/dev/null && ! grep -q '^work\.cptz\.space[[:space:]]*{' "$caddy_dir/Caddyfile"; then
  cp "$caddy_dir/Caddyfile" "backups/Caddyfile-$(date +%Y%m%d-%H%M%S)"
  cp "$caddy_dir/Caddyfile" "$caddy_dir/Caddyfile.workdeck-candidate"
  printf '\n' >> "$caddy_dir/Caddyfile.workdeck-candidate"
  cat build/deploy/Caddyfile.snippet >> "$caddy_dir/Caddyfile.workdeck-candidate"
  docker exec caddy caddy validate --config /etc/caddy/Caddyfile.workdeck-candidate --adapter caddyfile
  mv "$caddy_dir/Caddyfile.workdeck-candidate" "$caddy_dir/Caddyfile"
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
docker compose ps
REMOTE
printf '\nDeployed %s to https://work.example.com\n' "$version"
