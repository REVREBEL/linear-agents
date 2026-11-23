#!/usr/bin/env bash
# Operator-owned startup: immutable code, mutable task data.
set -euo pipefail
umask 077
readonly ENV_FILE=/etc/agent-bridge/bridge.env
readonly CODE_FILE=/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs
readonly DATA_DIR=/home/bridge/agent-bridge/linear-agent-bridge

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && -r "$ENV_FILE" ]] || exit 1
read -r uid gid perms < <(stat -c '%u %g %a' "$ENV_FILE")
[[ "$uid" == 0 && "$gid" == "$(id -g)" && "$perms" == 640 ]] || exit 1
[[ -f "$CODE_FILE" && ! -L "$CODE_FILE" ]] || exit 1
[[ -d "$DATA_DIR" ]] || exit 1
set -a
source "$ENV_FILE"
set +a
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV PYTHONPATH
export BRIDGE_RUNTIME_PROJECT_DIR="$DATA_DIR"
export NODE_ENV=production
[[ -n "$BRIDGE_SHARED_SECRET" ]] || exit 1
exec /usr/bin/node "$CODE_FILE"
