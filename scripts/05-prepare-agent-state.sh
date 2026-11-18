#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
# Never merge agent profiles: credentials, provider auth, and session files are identity-scoped.
getent group bridge-adm >/dev/null || groupadd --system bridge-adm
getent group bridge-usr >/dev/null || groupadd --system bridge-usr
install -d -m 0700 /opt/agents
for app in gemini kilo codex opencode; do
  install -d -m 0750 -o root -g bridge-adm "/opt/agents/$app"
done
install -d -m 0755 /opt/agent-tools/bin /opt/venv
cat <<'NOTICE'
SUCCESS: Prepared /opt/agents profiles (root:bridge-adm 0750).
No existing credentials, sessions, memory, or agent configuration were moved.
Do not run multiple writing Unix identities against one profile.
Assign a stable service user before importing per-user state or enabling services.
NOTICE
