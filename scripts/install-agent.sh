#!/bin/sh
set -eu
hub=''
token=''
node_name="$(hostname)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub) hub="$2"; shift 2;;
    --token) token="$2"; shift 2;;
    --name) node_name="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
[ -n "$hub" ] && [ -n "$token" ] || { echo 'Usage: sh install-agent.sh --hub https://your-hub --token TOKEN [--name NAME]' >&2; exit 1; }
case "$hub" in https://*) ;; *) echo 'HTTPS Hub URL required' >&2; exit 1;; esac
[ "$(uname -s)" = Linux ] || { echo 'This installer supports Linux only.' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported CPU architecture' >&2; exit 1;; esac
command -v tmux >/dev/null || { echo 'Install tmux first (for example: sudo apt install tmux).' >&2; exit 1; }
install_user="$(id -un)"
install_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
user_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"
[ -n "$install_home" ] || { echo 'Cannot resolve service account home' >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then
  systemctl show-environment >/dev/null
  service_dir=/etc/systemd/system
  service_target=multi-user.target
else
  systemctl --user show-environment >/dev/null || { echo 'A working user systemd manager is required.' >&2; exit 1; }
  service_dir="$install_home/.config/systemd/user"
  service_target=default.target
fi
mkdir -p "$install_home/.local/bin" "$service_dir" "$install_home/.local/share/workdeck"
chmod 700 "$install_home/.local/share/workdeck"
[ ! -f "$install_home/.local/share/workdeck/identity.json" ] || { echo 'This account already has a Workdeck identity. Installation stopped.' >&2; exit 1; }
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
curl -fsS "$hub/downloads/workdeck-linux-$arch" -o "$tmp_dir/workdeck"
curl -fsS "$hub/downloads/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"
expected="$(awk -v name="workdeck-linux-$arch" '$2==name {print $1}' "$tmp_dir/SHA256SUMS")"
[ -n "$expected" ] || { echo 'Missing download checksum' >&2; exit 1; }
printf '%s  %s\n' "$expected" "$tmp_dir/workdeck" | sha256sum -c -
install -m 755 "$tmp_dir/workdeck" "$install_home/.local/bin/workdeck"
printf '%s' "$token" > "$tmp_dir/token"
chmod 600 "$tmp_dir/token"
"$install_home/.local/bin/workdeck" agent enroll --data-dir "$install_home/.local/share/workdeck" --hub "$hub" --name "$node_name" --token-file "$tmp_dir/token"
cat > "$service_dir/workdeck-agent.service" <<UNIT
[Unit]
Description=Workdeck reverse-connection terminal Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=$install_home/.local/bin/workdeck agent run --data-dir $install_home/.local/share/workdeck
Restart=always
RestartSec=5
Environment=HOME=$install_home
Environment=SHELL=$user_shell
Environment=PATH=$install_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UMask=0077
UNIT
if [ "$(id -u)" = 0 ]; then printf 'User=%s\n' "$install_user" >> "$service_dir/workdeck-agent.service"; fi
printf '\n[Install]\nWantedBy=%s\n' "$service_target" >> "$service_dir/workdeck-agent.service"
if [ "$(id -u)" = 0 ]; then
  systemctl daemon-reload
  systemctl enable --now workdeck-agent.service
else
  systemctl --user daemon-reload
  systemctl --user enable --now workdeck-agent.service
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]; then
    printf '\nTo keep this user service running after logout and start it after boot, run:\n  sudo loginctl enable-linger %s\n' "$install_user"
  fi
fi
printf '\nAgent installed as %s. New terminals use this account.\n' "$install_user"
