# rebuild-opt-volta-node26.sh

cat > /root/rebuild-opt-volta-node26.sh <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || {
  echo "Run as root." >&2
  exit 1
}

SOURCE=/root/.volta
TARGET=/opt/volta
LOG_DIR=/var/log/global-app-migration

mkdir -p "$LOG_DIR"

LOG="$LOG_DIR/rebuild-opt-volta-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1

trap 'code=$?; echo "FAILED (exit $code). Log: $LOG" >&2' ERR

# Preserve the working n8n installation.
[[ -x "$SOURCE/bin/volta" ]] || {
  echo "Missing $SOURCE/bin/volta" >&2
  exit 1
}

[[ -x "$SOURCE/bin/volta-shim" ]] || {
  echo "Missing $SOURCE/bin/volta-shim" >&2
  exit 1
}

[[ ! -L "$SOURCE" ]] || {
  echo "Root Volta is a symlink; refusing to modify it." >&2
  exit 1
}

[[ "$(readlink -f "$SOURCE")" != "$(readlink -f "$TARGET")" ]] || {
  echo "Source and target resolve to the same directory." >&2
  exit 1
}

# Archive the incomplete /opt installation.
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  BACKUP="/opt/volta.before-rebuild.$(date -u +%Y%m%dT%H%M%SZ)"
  echo "Archiving $TARGET to $BACKUP"
  mv -- "$TARGET" "$BACKUP"
fi

install -d -m 0755 "$TARGET/bin"

# Copy the working Volta executables.
for executable in volta volta-shim; do
  install -m 0755 \
    "$SOURCE/bin/$executable" \
    "$TARGET/bin/$executable"
done

if [[ -x "$SOURCE/bin/volta-migrate" ]]; then
  install -m 0755 \
    "$SOURCE/bin/volta-migrate" \
    "$TARGET/bin/volta-migrate"
fi

export VOLTA_HOME="$TARGET"
export VOLTA_FEATURE_PNPM=1
export PATH="$TARGET/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

unset VOLTA_NODE_VERSION VOLTA_NPM_VERSION \
  VOLTA_YARN_VERSION VOLTA_PNPM_VERSION || true

V="$TARGET/bin/volta"

echo "=== Install Node 26 ==="
"$V" install node@26.13.0

echo "=== Upgrade replaceable applications ==="

for package in \
  @budibase/cli \
  @pimzino/agentic-tools-mcp \
  pm2 \
  web-push \
  pnpm \
  prettier
do
  echo "Installing $package@latest"
  "$V" install "$package@latest"
done

echo "=== Upgrade npm and Yarn ==="
"$V" install npm@latest
"$V" install yarn@latest

echo "=== Normalize shim symlinks ==="

for command in node npm npx pnpm pnpx yarn yarnpkg; do
  if [[ -L "$TARGET/bin/$command" ]]; then
    ln -sfn ./volta-shim "$TARGET/bin/$command"
  fi
done

echo "=== Final verification ==="

"$V" --version
"$TARGET/bin/node" --version
"$TARGET/bin/npm" --version
"$V" list all

if "$V" list all | grep -Eq '^[[:space:]]+n8n@'; then
  echo "Unexpected n8n installation in /opt." >&2
  exit 1
fi

echo "SUCCESS: Clean Node 26 environment at $TARGET"
echo "Preserved: /root/.volta and Agent Bridge"
echo "Log: $LOG"
SCRIPT

chmod +x /root/rebuild-opt-volta-node26.sh
bash /root/rebuild-opt-volta-node26.sh
