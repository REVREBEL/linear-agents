#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
[[ -x /opt/volta/bin/node && -x /opt/volta/bin/volta ]] || { echo 'Shared Volta missing' >&2; exit 1; }
install -d -m 0755 /opt/agent-tools/bin
# This wrapper supplies shared tools to ANY working directory, without modifying
# login profiles, SSH environment, systemd units or the existing Agent Bridge.
cat > /opt/agent-tools/bin/agent-exec <<'WRAPPER'
#!/usr/bin/env bash
set -Eeuo pipefail
if (( $# < 1 )); then
  printf 'Usage: agent-exec <command> [args...]\n' >&2
  exit 64
fi
export VOLTA_HOME=/opt/volta
export VOLTA_FEATURE_PNPM=1
export UV_TOOL_DIR=/opt/uv/tools
export UV_CACHE_DIR=/opt/uv/cache
export PATH=/opt/agent-tools/bin:/opt/volta/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin
# Do not set HOME/XDG here: those depend on the intended AGENT IDENTITY.
exec "$@"
WRAPPER
chmod 0755 /opt/agent-tools/bin/agent-exec
[[ -x /opt/agent-tools/bin/agent-exec ]]
echo 'PASS /opt/agent-tools/bin/agent-exec created; login profiles unchanged.'
