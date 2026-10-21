#!/usr/bin/env bash
# Render/install a domain-derived macOS LaunchAgent without touching running services.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then echo "macOS required" >&2; exit 1; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEMPLATE="$ROOT/scripts/macos/agent-bridge.plist.example"
ENV_FILE="${LINEAR_AGENTS_ENV_FILE:-$ROOT/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; copy .env.example to .env and configure before installing" >&2
  exit 1
fi
# .env is a trusted, local Bash configuration file.
export REPO_ROOT="$ROOT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
if [[ -z "${DOMAIN:-}" ]]; then echo "DOMAIN must be configured in $ENV_FILE" >&2; exit 1; fi
# Only conventional DNS domain labels; reject shell fragments and whitespace.
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Invalid DOMAIN: must be a DNS name such as example.com" >&2; exit 1
fi
lower_domain="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
IFS='.' read -r -a parts <<< "$lower_domain"
reversed=""
for part in "${parts[@]}"; do
  if [[ -z "$reversed" ]]; then reversed="$part"; else reversed="$part.$reversed"; fi
done
LABEL="$reversed.agent-bridge"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ ! -f "$TEMPLATE" ]]; then echo "Missing $TEMPLATE" >&2; exit 1; fi
if [[ "$ROOT" == *"__REPO_ROOT__"* ]]; then echo "Unsupported checkout directory name" >&2; exit 1; fi
# Install the shared npm workspace toolchain before changing the LaunchAgent.
# This does not deploy Workers or restart the existing service.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Ensure both are available via PATH in .env." >&2
  exit 1
fi
if [[ ! -f "$ROOT/package-lock.json" ]]; then
  echo "Missing root package-lock.json; cannot install shared npm dependencies." >&2
  exit 1
fi
echo "Installing shared npm workspace dependencies..."
(
  cd "$ROOT"
  npm ci
)
if [[ ! -x "$ROOT/node_modules/.bin/wrangler" ]]; then
  echo "Wrangler was not installed at $ROOT/node_modules/.bin/wrangler" >&2
  exit 1
fi
echo "Node.js dependencies ready."

# The Python runner lives beside agent-bridge.mjs, not in any routed project.
# Create its venv on first install; refresh declared packages on later installs.
BRIDGE_DIR="$ROOT/linear-agent-bridge"
VENV="$BRIDGE_DIR/.venv"
if [[ -n "${PYTHON_BIN:-}" && "$PYTHON_BIN" != "$VENV/bin/python" ]]; then
  echo "PYTHON_BIN points to $PYTHON_BIN instead of $VENV/bin/python." >&2
  echo "Remove PYTHON_BIN from .env to use the automatically managed bridge venv." >&2
  exit 1
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 is required to create $VENV" >&2
    exit 1
  fi
  echo "Creating Python virtual environment: $VENV"
  python3 -m venv "$VENV"
fi
if ! "$VENV/bin/python" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10 or newer is required"' ; then
  echo "Python 3.10 or newer is required for the bridge runner" >&2
  exit 1
fi
echo "Installing Python bridge dependencies..."
"$VENV/bin/python" -m pip install -r "$BRIDGE_DIR/requirements.txt"
"$VENV/bin/python" -c 'import requests'
echo "Python environment ready: $VENV"

mkdir -p "$(dirname "$TARGET")"
TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT
REPO_ROOT="$ROOT" LABEL="$LABEL" TEMPLATE="$TEMPLATE" OUTPUT="$TEMP" python3 - <<'PY'
import os
from pathlib import Path
from xml.sax.saxutils import escape
template = Path(os.environ["TEMPLATE"]).read_text()
template = template.replace("__REPO_ROOT__", escape(os.environ["REPO_ROOT"]))
template = template.replace("__LAUNCHAGENT_LABEL__", escape(os.environ["LABEL"]))
Path(os.environ["OUTPUT"]).write_text(template)
PY
plutil -lint "$TEMP" >/dev/null
if [[ -e "$TARGET" ]]; then
  BACKUP="$TARGET.backup.$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
  echo "Existing LaunchAgent backed up to $BACKUP"
fi
install -m 644 "$TEMP" "$TARGET"
echo "Installed $TARGET (label: $LABEL)"
echo "Service not reloaded. Run these commands when ready:"
printf '\nPLIST=%q\n' "$TARGET"
printf 'launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true\n'
printf 'launchctl bootstrap gui/$(id -u) "$PLIST"\n'
printf 'launchctl print %q\n' "gui/$(id -u)/$LABEL"
printf 'curl -fsS http://127.0.0.1:8788/health\n\n'
echo "See docs/MACOS_LAUNCHAGENT.md for instructions."
echo "If upgrading from another label, unload/remove its old LaunchAgent separately."
