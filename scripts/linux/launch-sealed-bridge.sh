#!/usr/bin/env bash
# Operator-owned startup: immutable code, mutable task data.
set -euo pipefail
umask 077
readonly ENV_FILE=/etc/agent-bridge/bridge.env
readonly CODE_FILE=/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs
readonly DATA_DIR=/home/bridge/agent-bridge/linear-agent-bridge
# The long-lived job-state lives behind a host symlink. Pin the underlying
# real directory so a replaced link or an empty checkout cannot re-admit jobs.
readonly EXPECTED_DATA_REAL=/opt/workspaces/bridge/agent-bridge/linear-agent-bridge

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && -r "$ENV_FILE" ]] || exit 1
read -r uid gid perms < <(/usr/bin/stat -c '%u %g %a' "$ENV_FILE")
[[ "$uid" == 0 && "$gid" == "$(/usr/bin/id -g)" && "$perms" == 640 ]] || exit 1
[[ -f "$CODE_FILE" && ! -L "$CODE_FILE" ]] || exit 1
[[ -d "$DATA_DIR" ]] || exit 1
[[ "$(/usr/bin/realpath -e -- "$DATA_DIR")" == "$EXPECTED_DATA_REAL" ]] || exit 1
[[ ! -L "$DATA_DIR/linear-jobs" && ! -L "$DATA_DIR/linear-jobs/job-state" ]] || exit 1
[[ -d "$DATA_DIR/linear-jobs/job-state" ]] || exit 1
# Before any new job is admitted, prove we retained the old durable ledger.
[[ -n "$(/usr/bin/find "$DATA_DIR/linear-jobs/job-state" -mindepth 2 -maxdepth 2   -name state.json -type f -print -quit)" ]] || exit 1
# Require a root-owned compatible system binary; do not execute the
# bridge-writable shared Volta shim through PATH.
[[ -x /usr/bin/node && ! -L /usr/bin/node ]] || exit 1
node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 20 ]] || exit 1
# Operator-only diagnostics: all checks without loading secrets or launching.
if [[ "${1:-}" == "--preflight" ]]; then
  echo 'SEALED_BRIDGE_PREFLIGHT=PASS'
  exit 0
fi
[[ "$#" == 0 ]] || exit 1
set -a
source "$ENV_FILE"
set +a
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV PYTHONPATH
export BRIDGE_RUNTIME_PROJECT_DIR="$DATA_DIR"
export NODE_ENV=production
[[ -n "$BRIDGE_SHARED_SECRET" ]] || exit 1
# This root-owned executable has already passed the explicit Node 20+ check.
exec /usr/bin/node "$CODE_FILE"
