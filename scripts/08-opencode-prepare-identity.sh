#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
id bridge >/dev/null || { echo 'Missing service user bridge' >&2; exit 1; }
getent group bridge-adm >/dev/null || { echo 'Missing group bridge-adm' >&2; exit 1; }
[[ -x /opt/agent-tools/bin/opencode ]] || { echo 'Missing OpenCode binary' >&2; exit 1; }
install -d -m 0711 /opt/agents
chmod 0711 /opt/agents
install -d -o bridge -g bridge-adm -m 0700 /opt/agents/opencode
chown bridge:bridge-adm /opt/agents/opencode
chmod 0700 /opt/agents/opencode
for dir in .config .config/opencode .local .local/share .local/state .cache .cache/opencode; do
  install -d -o bridge -g bridge-adm -m 0700 "/opt/agents/opencode/$dir"
done
echo 'PASS: bridge identity and private OpenCode state prepared; other agents untouched'
