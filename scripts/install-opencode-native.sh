#!/usr/bin/env bash
set -Eeuo pipefail

(( EUID == 0 )) || {
  echo "ERROR: Run as root." >&2
  exit 1
}

SOURCE="/home/bridge/.volta/tools/image/packages/@opencode/cli/lib/node_modules/@opencode/cli/bin/opencode.exe"
DEST_DIR="/opt/agent-tools/bin"
DEST="$DEST_DIR/opencode"
LOG_DIR="/var/log/global-app-migration"

mkdir -p "$DEST_DIR" "$LOG_DIR"
chmod 755 "$DEST_DIR"

LOG="$LOG_DIR/install-opencode-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1

trap 'rc=$?; echo "FAILED: exit $rc. Log: $LOG" >&2' ERR

echo "=== Validate native binary ==="

[[ -f "$SOURCE" && -x "$SOURCE" ]] || {
  echo "ERROR: Existing OpenCode executable not found: $SOURCE" >&2
  exit 1
}

file "$SOURCE"

file -b "$SOURCE" | grep -q 'ELF 64-bit.*x86-64' || {
  echo "ERROR: Source is not a Linux x86-64 executable." >&2
  exit 1
}

echo "=== Install standalone OpenCode ==="

TMP="$(mktemp "$DEST_DIR/.opencode.XXXXXXXX")"

cleanup() {
  rm -f -- "$TMP"
}
trap cleanup EXIT

install -m 0755 "$SOURCE" "$TMP"

echo "=== Verify candidate ==="
"$TMP" --version

if [[ -e "$DEST" ]]; then
  BACKUP="$DEST.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$DEST" "$BACKUP"
  echo "Previous binary backed up: $BACKUP"
fi

mv -f -- "$TMP" "$DEST"

echo "=== Verify installation ==="

"$DEST" --version
sha256sum "$SOURCE" "$DEST"

echo "=== Confirm executable permissions ==="
ls -lh "$DEST"

echo "SUCCESS: Shared OpenCode executable installed."
echo "Path: $DEST"
echo "Log: $LOG"
