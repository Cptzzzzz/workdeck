#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
version="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
mkdir -p bin web/public/downloads
printf '%s\n' "$version" > bin/VERSION
npm ci --prefix web
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags="-s -w -X main.version=$version" -o "bin/workdeck-linux-$arch" ./cmd/workdeck
  cp "bin/workdeck-linux-$arch" "web/public/downloads/"
done
(cd web/public/downloads && sha256sum workdeck-linux-* > SHA256SUMS)
cp scripts/install-agent.sh web/public/install-agent.sh
npm run build --prefix web
