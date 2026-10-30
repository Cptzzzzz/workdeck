#!/bin/sh
# Run only in a disposable container; no host services or identities are used.
set -eu
repo="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
docker run --rm -i -v "$repo/scripts/install-agent.sh:/fixture/install-agent.sh:ro" golang:1.25-alpine sh -s <<'TEST'
set -eu
mkdir -p /tmp/mockbin /tmp/fixture
cat > /tmp/fixture/workdeck <<'BIN'
#!/bin/sh
if [ "$1" = version ]; then echo fixture-new; exit 0; fi
if [ "$1" = agent ] && [ "$2" = enroll ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --data-dir ]; then target="$2"; shift 2; else shift; fi
  done
  printf 'fixture identity\n' > "$target/identity.json"
  exit 0
fi
exit 1
BIN
chmod 755 /tmp/fixture/workdeck
cat > /tmp/mockbin/curl <<'CURL'
#!/bin/sh
case "$2" in
  */downloads/SHA256SUMS)
    sum="$(sha256sum /tmp/fixture/workdeck | awk '{print $1}')"
    if [ -f /tmp/fixture/bad-checksum ]; then sum="0000000000000000000000000000000000000000000000000000000000000000"; fi
    printf '%s  workdeck-linux-amd64\n%s  workdeck-linux-arm64\n' "$sum" "$sum" > "$4";;
  */downloads/workdeck-linux-*) cp /tmp/fixture/workdeck "$4";;
  *) exit 1;;
esac
CURL
cat > /tmp/mockbin/systemctl <<'SYSTEMCTL'
#!/bin/sh
printf '%s\n' "$*" >> /tmp/fixture/systemctl.log
case "$*" in
  *restart*) if [ -f /tmp/fixture/fail-once ]; then rm /tmp/fixture/fail-once; exit 1; fi;;
esac
exit 0
SYSTEMCTL
printf '#!/bin/sh\nexit 0\n' > /tmp/mockbin/tmux
printf '#!/bin/sh\necho yes\n' > /tmp/mockbin/loginctl
chmod 755 /tmp/mockbin/*
export PATH="/tmp/mockbin:$PATH"
mkdir -p /root/.local/bin /root/.local/share/workdeck /etc/systemd/system /usr/local/libexec
printf '#!/bin/sh\necho fixture-old\n' > /root/.local/bin/workdeck
chmod 755 /root/.local/bin/workdeck
cp /root/.local/bin/workdeck /usr/local/libexec/workdeck-file-worker
printf 'existing identity\n' > /root/.local/share/workdeck/identity.json
printf 'existing service\n' > /etc/systemd/system/workdeck-agent.service
cp /root/.local/share/workdeck/identity.json /tmp/fixture/identity-before
old_agent="$(sha256sum /root/.local/bin/workdeck | cut -d' ' -f1)"
old_helper="$(sha256sum /usr/local/libexec/workdeck-file-worker | cut -d' ' -f1)"
touch /tmp/fixture/fail-once
if sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade >/tmp/fixture/failure.log 2>&1; then echo 'failed restart unexpectedly succeeded' >&2; exit 1; fi
[ "$(sha256sum /root/.local/bin/workdeck | cut -d' ' -f1)" = "$old_agent" ]
[ "$(sha256sum /usr/local/libexec/workdeck-file-worker | cut -d' ' -f1)" = "$old_helper" ]
cmp /tmp/fixture/identity-before /root/.local/share/workdeck/identity.json
[ "$(grep -c '^restart workdeck-agent.service$' /tmp/fixture/systemctl.log)" = 2 ]
: > /tmp/fixture/systemctl.log
chmod 777 /usr/local/libexec
if sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade >/tmp/fixture/unsafe.log 2>&1; then echo 'unsafe directory accepted' >&2; exit 1; fi
chmod 755 /usr/local/libexec
[ "$(sha256sum /root/.local/bin/workdeck | cut -d' ' -f1)" = "$old_agent" ]
! grep -q '^restart ' /tmp/fixture/systemctl.log
chmod 700 /usr/local/libexec
if sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade >/tmp/fixture/inaccessible.log 2>&1; then echo 'inaccessible helper directory accepted' >&2; exit 1; fi
chmod 755 /usr/local/libexec
! grep -q '^restart ' /tmp/fixture/systemctl.log
touch /tmp/fixture/bad-checksum
if sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade >/tmp/fixture/checksum.log 2>&1; then echo 'bad checksum accepted' >&2; exit 1; fi
rm /tmp/fixture/bad-checksum
[ "$(sha256sum /root/.local/bin/workdeck | cut -d' ' -f1)" = "$old_agent" ]
! grep -q '^restart ' /tmp/fixture/systemctl.log
sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade >/tmp/fixture/success.log
cmp /tmp/fixture/workdeck /root/.local/bin/workdeck
cmp /tmp/fixture/workdeck /usr/local/libexec/workdeck-file-worker
cmp /tmp/fixture/identity-before /root/.local/share/workdeck/identity.json
[ "$(stat -c %u /usr/local/libexec/workdeck-file-worker)" = 0 ]
[ "$(stat -c %a /usr/local/libexec/workdeck-file-worker)" = 755 ]
[ "$(grep -c '^restart workdeck-agent.service$' /tmp/fixture/systemctl.log)" = 1 ]
! grep -q 'workdeck-session-' /tmp/fixture/systemctl.log
rm /root/.local/share/workdeck/identity.json
rm /etc/systemd/system/workdeck-agent.service
rm /root/.local/bin/workdeck
: > /tmp/fixture/systemctl.log
sh /fixture/install-agent.sh --hub https://hub.example.invalid --token fixture-token --name fixture >/tmp/fixture/fresh.log
cmp /tmp/fixture/workdeck /usr/local/libexec/workdeck-file-worker
grep -q '^User=root$' /etc/systemd/system/workdeck-agent.service
grep -q '^enable --now workdeck-agent.service$' /tmp/fixture/systemctl.log
! grep -q 'workdeck-session-' /tmp/fixture/systemctl.log
adduser -D -s /bin/sh workdeckfixture
[ "$(su -s /bin/sh workdeckfixture -c '/usr/local/libexec/workdeck-file-worker version')" = fixture-new ]
chmod 666 /tmp/fixture/systemctl.log
: > /tmp/fixture/systemctl.log
su -s /bin/sh workdeckfixture -c 'PATH=/tmp/mockbin:$PATH sh /fixture/install-agent.sh --hub https://hub.example.invalid --token fixture-token --name user-fixture' >/tmp/fixture/user-fresh.log
cmp /tmp/fixture/workdeck /home/workdeckfixture/.local/bin/workdeck
cmp /tmp/fixture/workdeck /usr/local/libexec/workdeck-file-worker
grep -q '^--user enable --now workdeck-agent.service$' /tmp/fixture/systemctl.log
! grep -q '^User=' /home/workdeckfixture/.config/systemd/user/workdeck-agent.service
cp /home/workdeckfixture/.local/share/workdeck/identity.json /tmp/fixture/user-identity-before
: > /tmp/fixture/systemctl.log
su -s /bin/sh workdeckfixture -c 'PATH=/tmp/mockbin:$PATH sh /fixture/install-agent.sh --hub https://hub.example.invalid --upgrade' >/tmp/fixture/user-upgrade.log
cmp /tmp/fixture/user-identity-before /home/workdeckfixture/.local/share/workdeck/identity.json
grep -q '^--user restart workdeck-agent.service$' /tmp/fixture/systemctl.log
! grep -q 'workdeck-session-' /tmp/fixture/systemctl.log
echo 'Agent installer: isolated root and user installation, upgrade, rollback, unsafe path and checksum tests passed.'
TEST
