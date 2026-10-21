#!/usr/bin/env bash
# Render/install the LaunchAgent definition without touching running services.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then echo "macOS required" >&2; exit 1; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEMPLATE="$ROOT/scripts/macos/io.revrebel.agent-bridge.plist.example"
TARGET="$HOME/Library/LaunchAgents/io.revrebel.agent-bridge.plist"
if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env; copy .env.example to .env and configure before installing" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then echo "Missing $TEMPLATE" >&2; exit 1; fi
if [[ "$ROOT" == *"__REPO_ROOT__"* ]]; then echo "Unsupported checkout directory name" >&2; exit 1; fi
mkdir -p "$(dirname "$TARGET")"
TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT
REPO_ROOT="$ROOT" TEMPLATE="$TEMPLATE" OUTPUT="$TEMP" python3 - <<'PY'
import os
from pathlib import Path
t = Path(os.environ["TEMPLATE"]).read_text()
# XML escape absolute path when substituting into <string> elements.
from xml.sax.saxutils import escape
t = t.replace("__REPO_ROOT__", escape(os.environ["REPO_ROOT"]))
Path(os.environ["OUTPUT"]).write_text(t)
PY
plutil -lint "$TEMP" >/dev/null
if [[ -e "$TARGET" ]]; then
  BACKUP="$TARGET.backup.$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
  echo "Existing LaunchAgent backed up to $BACKUP"
fi
install -m 644 "$TEMP" "$TARGET"
echo "Installed $TARGET"
echo "Service not reloaded. Review the configuration and follow docs/MACOS_LAUNCHAGENT.md."
