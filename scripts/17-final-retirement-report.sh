#!/usr/bin/env bash
set -Eeuo pipefail
# Read-only. Does not remove user directories, active service assets, n8n, or the Bridge.
report_dir=/var/log/global-app-migration
install -d -m 0755 "$report_dir"
report="$report_dir/agent-retirement-report-$(date -u +%Y%m%dT%H%M%SZ).txt"
exec > >(tee -a "$report") 2>&1
echo '=== Central installation ==='
for p in /opt/volta /opt/agent-tools /opt/agents /opt/bun /opt/uv /opt/venv; do
  [[ -e "$p" ]] && du -sh "$p" || true
done
echo '=== Duplicate per-user tool directories, inventory only ==='
for p in /home/bridge/.volta /home/rebel/.volta /root/.volta /home/bridge/.local/share/uv /home/rebel/.local/share/uv /root/.bun; do
  [[ -d "$p" ]] && du -sh "$p" || true
done
echo '=== Active service startup references (no secrets printed) ==='
for unit in agent-bridge.service opencode-central.service pm2-root.service; do
  echo "-- $unit --"
  systemctl show "$unit" -p ActiveState -p User -p FragmentPath --no-pager 2>/dev/null || true
done
echo '=== Existing OpenCode processes ==='
pgrep -af '[/]opt/agent-tools/bin/opencode|[/]home/bridge/.volta/.*/opencode.exe' || true
echo '=== Reminder ==='
echo 'No deletion performed. Retire per-user installations only after startup references and interactive PATHs use central locations.'
echo 'Out of scope: /home/intergrations/stayntouch-data-receiver/${HOME}/.volta'
echo "Report: $report"
