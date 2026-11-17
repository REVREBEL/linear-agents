#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
SOURCE=/opt/scripts/generated/opencode-central.service
TARGET=/etc/systemd/system/opencode-central.service
[[ -f "$SOURCE" && -r /etc/agent-tools/opencode.env && -x /opt/agent-tools/bin/opencode ]] || { echo 'Run 08 and 09 first' >&2; exit 1; }
if [[ -e "$TARGET" ]] && ! cmp -s "$SOURCE" "$TARGET"; then
  echo 'An existing central service unit differs; refusing overwrite' >&2
  exit 1
fi
if ss -H -ltn '( sport = :4096 )' | grep -q .; then
  if ! systemctl is-active --quiet opencode-central.service; then
    echo 'Port 4096 already occupied; refusing to start another server' >&2
    exit 1
  fi
fi
install -m 0644 "$SOURCE" "$TARGET"
systemctl daemon-reload
systemctl enable --now opencode-central.service
systemctl --no-pager --full status opencode-central.service
echo 'PASS: only opencode-central.service activated'
