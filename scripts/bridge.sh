#!/usr/bin/env bash
set -euo pipefail

# Load the same trusted root configuration used by the Worker and installer scripts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${LINEAR_AGENTS_ENV_FILE:-${REPO_ROOT}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: Missing environment file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${DOMAIN:-}" || ! "${DOMAIN}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Error: DOMAIN must be a valid DNS name in ${ENV_FILE}" >&2
  exit 1
fi

# Match the installer's domain-derived launchd label for any number of labels.
domain_lower="$(printf '%s' "${DOMAIN}" | tr '[:upper:]' '[:lower:]')"
IFS='.' read -r -a domain_parts <<< "${domain_lower}"
reversed=""
for part in "${domain_parts[@]}"; do
  reversed="${part}${reversed:+.${reversed}}"
done
REVERSED_ID="${reversed}.agent-bridge"
PLIST="${HOME}/Library/LaunchAgents/${REVERSED_ID}.plist"
SERVICE_TARGET="gui/$(id -u)/${REVERSED_ID}"

# 2. Command Handler
case "${1:-}" in
  load)
    echo "Loading LaunchAgent..."
    # Force unload existing session if present to avoid error 5
    launchctl bootout "gui/$(id -u)" "${PLIST}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "${PLIST}"
    echo "Successfully loaded ${REVERSED_ID}"
    ;;

  unload)
    echo "Unloading LaunchAgent..."
    launchctl bootout "gui/$(id -u)" "${PLIST}"
    ;;

  restart)
    echo "Restarting LaunchAgent..."
    cd "${SCRIPT_DIR}/../linear-agent-bridge" || exit 1
    launchctl kickstart -k "${SERVICE_TARGET}"
    ;;

  status)
    echo "=== Launchctl Status ==="
    launchctl list | grep "${REVERSED_ID}" || echo "Service is not running in launchctl"
    echo ""
    echo "=== Health Check Endpoint ==="
    curl -fsS http://127.0.0.1:8788/health || echo -e "\nHealth check failed"
    ;;

  *)
    echo "Usage: $0 {load|unload|restart|status}"
    exit 1
    ;;
esac