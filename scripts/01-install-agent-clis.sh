#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
export VOLTA_HOME=/opt/volta VOLTA_FEATURE_PNPM=1
export PATH="$VOLTA_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ -x "$VOLTA_HOME/bin/volta" && -x "$VOLTA_HOME/bin/node" ]] || { echo 'Shared Volta not installed' >&2; exit 1; }
[[ "$("$VOLTA_HOME/bin/node" --version)" == v26.* ]] || { echo 'Expected shared Node 26' >&2; exit 1; }
mkdir -p /var/log/global-app-migration
log="/var/log/global-app-migration/agents-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log") 2>&1
for spec in '@google/gemini-cli@latest' '@kilocode/cli@latest' 'mcp-server-linear@latest'; do
  echo "Installing $spec"
  "$VOLTA_HOME/bin/volta" install "$spec"
done
for name in gemini kilo kilocode mcp-server-linear; do
  [[ -x "$VOLTA_HOME/bin/$name" ]] || { echo "Missing $name" >&2; exit 1; }
done
"$VOLTA_HOME/bin/gemini" --version
"$VOLTA_HOME/bin/kilo" --version
"$VOLTA_HOME/bin/volta" list all
printf 'SUCCESS: %s\n' "$log"
