#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
install -d -m 0755 /opt/agent-tools/bin /opt/uv /var/log/global-app-migration
# Reuse a known Ubuntu-installed uv binary if available; no downloading opaque shell scripts.
src=''
for candidate in /home/bridge/.local/bin/uv /home/rebel/.local/bin/uv /root/.local/bin/uv /usr/local/bin/uv /usr/bin/uv; do
  if [[ -x "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then src="$candidate"; break; fi
done
[[ -n "$src" ]] || { echo 'No working uv binary found in known paths; stopping without changes.' >&2; exit 1; }
install -m 0755 "$src" /opt/agent-tools/bin/uv
if [[ -x "$(dirname "$src")/uvx" ]]; then
  install -m 0755 "$(dirname "$src")/uvx" /opt/agent-tools/bin/uvx
else
  ln -sfn uv /opt/agent-tools/bin/uvx
fi
/opt/agent-tools/bin/uv --version
# Use UV_TOOL_DIR and UV_CACHE_DIR for central tool installations, not the bridge's project venv.
echo 'Installed uv/uvx. Set UV_TOOL_DIR=/opt/uv/tools and UV_CACHE_DIR=/opt/uv/cache for future central tools.'
echo 'Mistral Vibe installation deliberately not automated: requires deliberate environment and tool CLI choices.'
