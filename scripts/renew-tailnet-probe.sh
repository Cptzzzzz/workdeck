#!/bin/sh
# Renew the optional Tailnet probe certificate without changing its secret.
set -eu
domain="${1:-}"
case "$domain" in *.ts.net) ;; *) echo 'Expected the probe device ts.net DNS name' >&2; exit 1;; esac
case "$domain" in *[!a-zA-Z0-9.-]*) echo 'Invalid Tailnet DNS name' >&2; exit 1;; esac
state=/var/lib/workdeck-tailnet-probe
private=/opt/stacks/workdeck/secrets/tailnet-probe
[ -d "$state" ] && [ ! -L "$state" ] && [ -d "$private" ] && [ ! -L "$private" ] || { echo 'Probe state directories are missing or unsafe' >&2; exit 1; }
tmp=$(mktemp -d "$private/renew.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
tailscale cert --min-validity=336h --cert-file "$tmp/cert.pem" --key-file "$tmp/key.pem" "$domain" >/dev/null
openssl x509 -in "$tmp/cert.pem" -noout -checkend 86400 -checkhost "$domain" >/dev/null
certpub=$(openssl x509 -in "$tmp/cert.pem" -pubkey -noout | openssl sha256)
keypub=$(openssl pkey -in "$tmp/key.pem" -pubout | openssl sha256)
[ "$certpub" = "$keypub" ] || { echo 'TLS certificate and key mismatch' >&2; exit 1; }
cmp -s "$tmp/cert.pem" "$state/current/cert.pem" && exit 0
old=$(readlink "$state/current")
case "$old" in cert.[A-Za-z0-9]*) ;; *) echo 'Unsafe current certificate link' >&2; exit 1;; esac
case "$old" in */*) echo 'Unsafe certificate link' >&2; exit 1;; esac
next=$(mktemp -d "$state/cert.XXXXXXXX")
chown root:workdeck-tailprobe "$next"; chmod 750 "$next"
install -o root -g workdeck-tailprobe -m 440 "$tmp/cert.pem" "$next/cert.pem"
install -o root -g workdeck-tailprobe -m 440 "$tmp/key.pem" "$next/key.pem"
ln -s "$(basename "$next")" "$state/.current.$$"
mv -Tf "$state/.current.$$" "$state/current"
if ! systemctl restart workdeck-tailnet-probe.service; then
  ln -s "$old" "$state/.rollback.$$"
  mv -Tf "$state/.rollback.$$" "$state/current"
  systemctl restart workdeck-tailnet-probe.service || true
  echo 'Probe restart failed; previous certificate restored' >&2
  exit 1
fi
