#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "ERROR: Run as root." >&2
  exit 1
fi

VOLTA_HOME=/opt/volta
export VOLTA_HOME
export VOLTA_FEATURE_PNPM=1
export PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin"

LOG_DIR=/var/log/global-app-migration
mkdir -p "$LOG_DIR"

LOG="$LOG_DIR/install-agent-clis-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1

trap 'rc=$?; echo "FAILED: exit $rc. Log: $LOG" >&2' ERR

VOLTA="$VOLTA_HOME/bin/volta"

[[ -x "$VOLTA" ]] || {
  echo "ERROR: Missing shared Volta executable." >&2
  exit 1
}

echo "=== Verify Node 26 ==="

NODE_VERSION=$("$VOLTA_HOME/bin/node" --version)

[[ "$NODE_VERSION" == v26.* ]] || {
  echo "ERROR: Expected Node 26, found $NODE_VERSION" >&2
  exit 1
}

echo "Node: $NODE_VERSION"

echo "=== Install agent CLIs ==="

packages=(
  "@google/gemini-cli@latest"
  "@kilocode/cli@latest"
  "mcp-server-linear@latest"
)

for package in "${packages[@]}"; do
  echo "Installing $package"
  "$VOLTA" install "$package"
done

echo "=== Verify executables ==="

for executable in gemini kilo kilocode mcp-server-linear; do
  path="$VOLTA_HOME/bin/$executable"

  if [[ ! -x "$path" ]]; then
    echo "ERROR: Missing executable: $path" >&2
    exit 1
  fi

  echo "OK: $executable"
done

echo "=== CLI versions ==="

"$VOLTA_HOME/bin/gemini" --version
"$VOLTA_HOME/bin/kilo" --version

echo "=== Final Volta inventory ==="
"$VOLTA" list all

echo "SUCCESS: Agent CLI installation complete."
echo "Log: $LOG"
