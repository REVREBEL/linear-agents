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
lower_domain="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"\nIFS='.' read -r -a parts <<< "$lower_domain"
reversed=""
for part in "${parts[@]}"; do
  if [[ -z "$reversed" ]]; then reversed="$part"; else reversed="$part.$reversed"; fi
done
LABEL="$reversed.agent-bridge"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ ! -f "$TEMPLATE" ]]; then echo "Missing $TEMPLATE" >&2; exit 1; fi
if [[ "$ROOT" == *"__REPO_ROOT__"* ]]; then echo "Unsupported checkout directory name" >&2; exit 1; fi
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
echo "Service not reloaded; follow docs/MACOS_LAUNCHAGENT.md."
echo "If upgrading from another label, unload/remove its old LaunchAgent separately."
