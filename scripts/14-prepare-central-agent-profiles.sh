#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
id bridge >/dev/null || { echo 'Existing bridge user is missing' >&2; exit 1; }
getent group bridge-adm >/dev/null || { echo 'Existing bridge-adm group is missing' >&2; exit 1; }
[[ -d /opt/agents ]] || { echo 'Run earlier base-directory setup first' >&2; exit 1; }
# Existing /opt/agents/opencode is deliberately not touched. No credentials copied.
# Keep metadata owned by root and each writable agent profile privately owned by bridge.
install -d -m 0711 /opt/agents
chmod 0711 /opt/agents
for name in gemini kilo codex; do
  target="/opt/agents/$name"
  if [[ -L "$target" ]]; then
    echo "Refusing to change symlinked profile $target" >&2
    exit 1
  fi
  install -d -o bridge -g bridge-adm -m 0700 "$target"
  chown bridge:bridge-adm "$target"
  chmod 0700 "$target"
  for folder in .config .cache .local .local/share .local/state; do
    install -d -o bridge -g bridge-adm -m 0700 "$target/$folder"
  done
  echo "Prepared $target (private writable profile; no account credentials migrated)"
done
# Note: different agents can need vendor-specific HOME/config paths.
# This script intentionally does not assume a single shared cross-vendor config format.
