#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
src='/root/.bun/bin/bun'
[[ -x "$src" ]] || { echo "Missing $src; not touching root Bun" >&2; exit 1; }
install -d -m 0755 /opt/bun/bin /var/log/global-app-migration
install -m 0755 "$src" /opt/bun/bin/bun
/opt/bun/bin/bun --version
if [[ -x /root/.bun/bin/bunx ]]; then
  install -m 0755 /root/.bun/bin/bunx /opt/bun/bin/bunx
else
  ln -sfn bun /opt/bun/bin/bunx
fi
printf '%s\n' 'SUCCESS: Bun binary copied; /root/.bun untouched.'
