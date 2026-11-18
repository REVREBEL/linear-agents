#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'ERROR: Run as root' >&2; exit 1; }
# Existing /opt/volta and /opt/zsh_config are intentionally untouched.
for dir in /opt/agent-tools/bin /opt/bun/bin /opt/uv /opt/venv /var/log/global-app-migration; do
  install -d -m 0755 "$dir"
done
# Agent state is private until a designated service identity is configured.
install -d -m 0700 /opt/agents
for agent in opencode gemini kilo codex; do
  install -d -m 0700 "/opt/agents/$agent"
done
printf 'SUCCESS: Base directories prepared (existing contents retained).\n'
