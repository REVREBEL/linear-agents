#!/usr/bin/env bash
set -Eeuo pipefail
echo '=== Core paths ==='
ls -l /opt/agent-tools/bin/opencode /opt/volta/bin/{node,gemini,kilo} 2>/dev/null || true
echo '=== Service and listener ==='
systemctl is-enabled opencode-central.service 2>/dev/null || true
systemctl is-active opencode-central.service 2>/dev/null || true
ss -ltn '( sport = :4096 )' || true
echo '=== SSH state ==='
systemctl is-active ssh.service 2>/dev/null || systemctl is-active sshd.service 2>/dev/null || true
echo '=== bridge account permission ==='
/usr/sbin/runuser -u bridge -- test -x /opt/agent-tools/bin/opencode && echo 'bridge can execute OpenCode'
/usr/sbin/runuser -u bridge -- test -w /opt/agents/opencode && echo 'bridge can write its profile'
echo '=== Old local toolchains: audit only ==='
for p in /home/bridge/.volta /home/rebel/.volta /root/.volta; do
  [[ -d "$p" ]] && du -sh "$p"
done
echo 'No deletion, proxy update, or service restart performed'
