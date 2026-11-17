#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
command -v /usr/sbin/runuser >/dev/null || true
report_dir=/var/log/global-app-migration
install -d -m 0755 "$report_dir"
report="$report_dir/agent-central-validation-$(date -u +%Y%m%dT%H%M%SZ).txt"
exec > >(tee -a "$report") 2>&1
fail=0
for target in /opt/agent-tools/bin/agent-exec /opt/agent-tools/bin/opencode /opt/volta/bin/node /opt/volta/bin/gemini /opt/volta/bin/kilo /opt/agent-tools/bin/uv /opt/bun/bin/bun; do
  if [[ -x "$target" ]]; then echo "PRESENT $target"; else echo "MISSING $target"; fail=1; fi
done
for name in bridge rebel; do
  id "$name" >/dev/null || { echo "Missing user $name"; fail=1; continue; }
  # Use runuser to ensure executable permission and PATH/Volta resolution independent of shell configuration.
  if /usr/sbin/runuser -u "$name" -- /opt/agent-tools/bin/agent-exec node --version; then
    echo "PASS $name via agent-exec: node"
  else
    echo "FAIL $name via agent-exec: node"; fail=1
  fi
done
# Do NOT launch OpenCode or invoke agent APIs, to avoid changing remote sessions.
python3 -m json.tool /opt/agents/registry/agent-runtimes.json >/dev/null || fail=1
for name in gemini kilo codex; do
  if /usr/sbin/runuser -u bridge -- test -w "/opt/agents/$name"; then
    echo "PASS bridge writable /opt/agents/$name"
  else
    echo "FAIL bridge cannot write /opt/agents/$name"; fail=1
  fi
done
if [[ "$fail" == 0 ]]; then echo 'PASS shared execution and registry checks'; else echo 'FAIL check lines above'; exit 1; fi
echo "Report: $report"
