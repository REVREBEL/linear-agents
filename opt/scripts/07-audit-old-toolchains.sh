#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
mkdir -p /var/log/global-app-migration
out="/var/log/global-app-migration/old-toolchains-$(date -u +%Y%m%dT%H%M%SZ).txt"
{
 echo '=== Central tools ==='
 for p in /opt/volta/bin/node /opt/volta/bin/volta /opt/agent-tools/bin/opencode /opt/agent-tools/bin/uv /opt/bun/bin/bun; do
   if [[ -e "$p" ]]; then ls -l "$p"; else echo "MISSING $p"; fi
 done
 echo '=== User-local installations (NO DELETION) ==='
 for p in /root/.volta /home/bridge/.volta /home/rebel/.volta /root/.bun /home/bridge/.local/share/uv /home/rebel/.local/share/uv; do
   [[ ! -e "$p" ]] || du -sh -- "$p" 2>/dev/null || true
 done
 echo '=== Critical service references (NO RESTARTS) ==='
 ps -eo user,pid,args | grep -E '[o]pencode|[a]gent-bridge|[n]8n|[p]m2' || true
 echo '=== Unit configuration references ==='
 grep -RIlE '/root/\.volta|/home/bridge/\.volta|/home/rebel/\.volta' /etc/systemd/system 2>/dev/null || true
 echo 'No files deleted. Do not remove old installations until service launch paths have been migrated.'
} | tee "$out"
echo "Report: $out"
