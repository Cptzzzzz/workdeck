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
systemctl --user show-environment >/dev/null || { echo 'A working user systemd manager is required.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Run the Agent as your normal work user, not root.' >&2; exit 1; }
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.local/share/workdeck"
chmod 700 "$HOME/.local/share/workdeck"
[ ! -f "$HOME/.local/share/workdeck/identity.json" ] || { echo 'This user already has a Workdeck identity. Installation stopped.' >&2; exit 1; }
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
curl -fsS "$hub/downloads/workdeck-linux-$arch" -o "$tmp_dir/workdeck"
curl -fsS "$hub/downloads/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"
expected="$(awk -v name="workdeck-linux-$arch" '$2==name {print $1}' "$tmp_dir/SHA256SUMS")"
[ -n "$expected" ] || { echo 'Missing download checksum' >&2; exit 1; }
printf '%s  %s\n' "$expected" "$tmp_dir/workdeck" | sha256sum -c -
install -m 755 "$tmp_dir/workdeck" "$HOME/.local/bin/workdeck"
printf '%s' "$token" > "$tmp_dir/token"
chmod 600 "$tmp_dir/token"
"$HOME/.local/bin/workdeck" agent enroll --hub "$hub" --name "$node_name" --token-file "$tmp_dir/token"
user_shell="$(getent passwd "$(id -un)" | cut -d: -f7)"
cat > "$HOME/.config/systemd/user/workdeck-agent.service" <<UNIT
[Unit]
Description=Workdeck reverse-connection terminal Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=%h/.local/bin/workdeck agent run
Restart=always
RestartSec=5
Environment=SHELL=$user_shell
Environment=PATH=$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UMask=0077
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now workdeck-agent.service
if [ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]; then
  printf '\nFor sessions to survive logout and Agent startup after reboot, run:\n  sudo loginctl enable-linger %s\n' "$(id -un)"
fi
printf '\nAgent installed. View status with: systemctl --user status workdeck-agent\n'
