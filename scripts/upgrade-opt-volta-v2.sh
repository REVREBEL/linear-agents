#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE=/root/.volta
TARGET=/opt/volta
LOG_DIR=/var/log/global-app-migration

[[ $EUID -eq 0 ]] || {
  echo "Run as root." >&2
  exit 1
}

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/upgrade-opt-volta-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1

trap 'code=$?; echo "FAILED (exit $code). Log: $LOG" >&2' ERR

echo "=== Validate existing Volta installation ==="

[[ -x "$SOURCE/bin/volta" ]] || {
  echo "Missing $SOURCE/bin/volta" >&2
  exit 1
}

[[ -x "$SOURCE/bin/volta-shim" ]] || {
  echo "Missing $SOURCE/bin/volta-shim" >&2
  exit 1
}

if [[ -L "$TARGET" ]]; then
  echo "Target must be a directory, not a symlink." >&2
  exit 1
fi

mkdir -p "$TARGET/bin"

echo "=== Restore Volta executables ==="

for executable in volta volta-shim volta-migrate; do
  if [[ -x "$SOURCE/bin/$executable" ]]; then
    install -m 0755 \
      "$SOURCE/bin/$executable" \
      "$TARGET/bin/$executable"
  fi
done

export VOLTA_HOME="$TARGET"
export VOLTA_FEATURE_PNPM=1
export PATH="$TARGET/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

unset VOLTA_NODE_VERSION VOLTA_NPM_VERSION \
  VOLTA_YARN_VERSION VOLTA_PNPM_VERSION || true

echo "=== Repair existing shim symlinks ==="

for command in node npm npx pnpm pnpx yarn yarnpkg; do
  if [[ ! -e "$TARGET/bin/$command" || -L "$TARGET/bin/$command" ]]; then
    ln -sfn ./volta-shim "$TARGET/bin/$command"
  fi
done

echo "=== Set Node 26 as default ==="

"$TARGET/bin/volta" install node@26.13.0

echo "=== Upgrade existing utilities ==="

for package in \
  @budibase/cli \
  @pimzino/agentic-tools-mcp \
  pm2 \
  web-push \
  pnpm \
  prettier
do
  echo "Installing $package@latest"
  "$TARGET/bin/volta" install "$package@latest"
done

echo "=== Upgrade npm and Yarn ==="

"$TARGET/bin/volta" install npm@latest
"$TARGET/bin/volta" install yarn@latest

echo "=== Final verification ==="

"$TARGET/bin/volta" --version
"$TARGET/bin/node" --version
"$TARGET/bin/npm" --version
"$TARGET/bin/volta" list all

echo "SUCCESS"
echo "Log: $LOG"

