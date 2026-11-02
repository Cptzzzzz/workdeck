#!/bin/sh
# Resolve the current local Tailscale address on each service start.
set -eu
origin="${1:-}"
port="${2:-}"
case "$origin" in https://*) ;; *) echo 'Expected the Workdeck HTTPS origin' >&2; exit 1;; esac
case "$origin" in *[!a-zA-Z0-9:./-]*) echo 'Invalid origin' >&2; exit 1;; esac
case "$port" in ''|*[!0-9]*) echo 'Expected a TCP port' >&2; exit 1;; esac
[ "$port" -gt 0 ] && [ "$port" -le 65535 ] || { echo 'Invalid TCP port' >&2; exit 1; }
ip=$(tailscale ip -4)
[ -n "$ip" ] || { echo 'Tailscale IPv4 address unavailable' >&2; exit 1; }
exec /usr/local/libexec/workdeck-tailnet-probe tailnet-probe \
  --addr="$ip:$port" --origin="$origin" \
  --secret-file=/var/lib/workdeck-tailnet-probe/secret \
  --tls-cert-file=/var/lib/workdeck-tailnet-probe/current/cert.pem \
  --tls-key-file=/var/lib/workdeck-tailnet-probe/current/key.pem
