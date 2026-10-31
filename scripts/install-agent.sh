#!/bin/sh
set -eu
hub=''
token=''
node_name="$(hostname)"
upgrade=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upgrade) upgrade=1; shift;;
    --hub) hub="$2"; shift 2;;
    --token) token="$2"; shift 2;;
    --name) node_name="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
[ -n "$hub" ] || { echo 'Usage: sh install-agent.sh --hub https://your-hub (--token TOKEN [--name NAME] | --upgrade)' >&2; exit 1; }
if [ "$upgrade" = 0 ]; then [ -n "$token" ] || { echo 'Enrollment requires a token.' >&2; exit 1; }; else [ -z "$token" ] || { echo 'Upgrade does not use an enrollment token.' >&2; exit 1; }; fi
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
identity="$install_home/.local/share/workdeck/identity.json"
if [ "$upgrade" = 0 ]; then
  [ ! -e "$identity" ] && [ ! -L "$identity" ] || { echo 'This account already has a Workdeck identity. Installation stopped.' >&2; exit 1; }
  [ ! -e "$service_dir/workdeck-agent.service" ] && [ ! -L "$service_dir/workdeck-agent.service" ] || { echo 'An Agent service file already exists. Installation stopped.' >&2; exit 1; }
  [ ! -e "$install_home/.local/bin/workdeck" ] && [ ! -L "$install_home/.local/bin/workdeck" ] || { echo 'An Agent executable already exists. Installation stopped.' >&2; exit 1; }
else
  [ -f "$identity" ] && [ ! -L "$identity" ] || { echo 'Upgrade requires an existing identity; no enrollment was attempted.' >&2; exit 1; }
  [ -f "$install_home/.local/bin/workdeck" ] && [ ! -L "$install_home/.local/bin/workdeck" ] || { echo 'Existing Agent executable is missing or is a symbolic link.' >&2; exit 1; }
  [ -f "$service_dir/workdeck-agent.service" ] && [ ! -L "$service_dir/workdeck-agent.service" ] || { echo 'Existing Agent service file is missing or is a symbolic link.' >&2; exit 1; }
fi
tmp_dir="$(mktemp -d)"
helper_tmp=''
agent_tmp=''
helper_changed=0
agent_changed=0
restart_attempted=0
upgrade_done=0
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$upgrade" = 1 ] && [ "$upgrade_done" = 0 ] && [ "$result" -ne 0 ]; then
    echo 'Upgrade failed; restoring the previous Agent and file worker.' >&2
    if [ "$agent_changed" = 1 ]; then
      restore="$(mktemp "$install_home/.local/bin/.workdeck-restore.XXXXXXXX")"
      cp -p "$tmp_dir/previous-agent" "$restore" && mv -f "$restore" "$install_home/.local/bin/workdeck" || echo 'Unable to restore Agent executable.' >&2
    fi
    if [ "$helper_changed" = 1 ]; then
      if [ -f "$tmp_dir/previous-helper" ]; then
        restore="$(mktemp /usr/local/libexec/.workdeck-restore.XXXXXXXX)"
        cp -p "$tmp_dir/previous-helper" "$restore" && mv -f "$restore" /usr/local/libexec/workdeck-file-worker || echo 'Unable to restore file worker.' >&2
      else
        rm -f /usr/local/libexec/workdeck-file-worker
      fi
    fi
    if [ "$restart_attempted" = 1 ]; then
      if [ "$(id -u)" = 0 ]; then systemctl restart workdeck-agent.service || echo 'Previous Agent could not be restarted.' >&2
      else systemctl --user restart workdeck-agent.service || echo 'Previous Agent could not be restarted.' >&2; fi
    fi
  fi
  [ -z "$helper_tmp" ] || rm -f "$helper_tmp"
  [ -z "$agent_tmp" ] || rm -f "$agent_tmp"
  rm -rf "$tmp_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
curl -fsS "$hub/downloads/workdeck-linux-$arch" -o "$tmp_dir/workdeck"
curl -fsS "$hub/downloads/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"
expected="$(awk -v name="workdeck-linux-$arch" '$2==name {print $1}' "$tmp_dir/SHA256SUMS")"
[ -n "$expected" ] || { echo 'Missing download checksum' >&2; exit 1; }
case "$expected" in *[!0123456789abcdef]*) echo 'Invalid download checksum' >&2; exit 1;; esac
[ "${#expected}" = 64 ] || { echo 'Invalid download checksum' >&2; exit 1; }
printf '%s  %s\n' "$expected" "$tmp_dir/workdeck" | sha256sum -c -
# curl creates a non-executable file, and temporary filesystems are often
# mounted noexec. Verify the checked binary from its actual installation
# filesystem before replacing the existing Agent.
agent_tmp="$(mktemp "$install_home/.local/bin/.workdeck.XXXXXXXX")"
install -m 700 "$tmp_dir/workdeck" "$agent_tmp"
"$agent_tmp" version >/dev/null || { echo 'Downloaded Agent is not executable on this machine.' >&2; exit 1; }
if [ "$upgrade" = 1 ]; then cp -p "$install_home/.local/bin/workdeck" "$tmp_dir/previous-agent"; fi
# Root agents may need to run file workers as the owners of older sessions.
# The helper and every parent directory must be root-owned and not writable
# by other accounts; never replace an unsafe path or follow a symlink.
if [ "$(id -u)" = 0 ]; then
  for parent in / /usr /usr/local; do
    [ -d "$parent" ] && [ ! -L "$parent" ] && [ "$(stat -c %u "$parent")" = 0 ] && [ $((0$(stat -c %a "$parent") & 022)) = 0 ] && [ $((0$(stat -c %a "$parent") & 001)) = 1 ] || { echo "Unsafe or inaccessible helper directory: $parent" >&2; exit 1; }
  done
  if [ ! -e /usr/local/libexec ] && [ ! -L /usr/local/libexec ]; then mkdir -m 755 /usr/local/libexec; fi
  [ -d /usr/local/libexec ] && [ ! -L /usr/local/libexec ] && [ "$(stat -c %u /usr/local/libexec)" = 0 ] && [ $((0$(stat -c %a /usr/local/libexec) & 022)) = 0 ] && [ $((0$(stat -c %a /usr/local/libexec) & 001)) = 1 ] || { echo 'Unsafe or inaccessible helper directory: /usr/local/libexec' >&2; exit 1; }
  [ ! -L /usr/local/libexec/workdeck-file-worker ] && [ ! -d /usr/local/libexec/workdeck-file-worker ] || { echo 'Unsafe existing file worker path.' >&2; exit 1; }
  if [ "$upgrade" = 1 ] && [ -f /usr/local/libexec/workdeck-file-worker ]; then cp -p /usr/local/libexec/workdeck-file-worker "$tmp_dir/previous-helper"; fi
  helper_tmp="$(mktemp /usr/local/libexec/.workdeck-file-worker.XXXXXXXX)"
  install -m 755 "$tmp_dir/workdeck" "$helper_tmp"
  chown 0:0 "$helper_tmp"
  mv -f "$helper_tmp" /usr/local/libexec/workdeck-file-worker
  helper_changed=1
fi
chmod 755 "$agent_tmp"
mv -f "$agent_tmp" "$install_home/.local/bin/workdeck"
agent_changed=1
if [ "$upgrade" = 1 ]; then
  restart_attempted=1
  if [ "$(id -u)" = 0 ]; then
    systemctl restart workdeck-agent.service
  else
    systemctl --user restart workdeck-agent.service
  fi
  upgrade_done=1
  printf '\nAgent updated as %s. Existing session units were not stopped.\n' "$install_user"
  exit 0
fi
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
