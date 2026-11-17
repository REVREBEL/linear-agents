set -e

echo "=== Install OpenCode ==="

# Use a temporary home to avoid modifying root's existing configuration.
INSTALL_HOME="$(mktemp -d)"
trap 'rm -rf -- "$INSTALL_HOME"' EXIT

curl -fsSL https://opencode.ai/install \
  | HOME="$INSTALL_HOME" bash

SOURCE="$INSTALL_HOME/.opencode/bin/opencode"
DEST="/opt/agent-tools/bin/opencode"

test -x "$SOURCE" || {
  echo "ERROR: OpenCode installer did not produce $SOURCE"
  exit 1
}

install -d -m 0755 /opt/agent-tools/bin
install -m 0755 "$SOURCE" "$DEST"

echo "=== Verify ==="
"$DEST" --version
ls -lh "$DEST"
