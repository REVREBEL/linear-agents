#!/usr/bin/env bash

# 1. Check if DOMAIN is set; if missing, fail with an error
if [ -z "${DOMAIN}" ]; then
  echo "Error: DOMAIN environment variable is required." >&2
  echo "Example: DOMAIN=revrebel.io npm run bridge:status" >&2
  exit 1
fi

REVERSED_ID=$(echo "${DOMAIN}" | awk -F. '{print $2 "." $1 ".agent-bridge"}')
PLIST="${HOME}/Library/LaunchAgents/${REVERSED_ID}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_TARGET="gui/$(id -u)/${REVERSED_ID}"

# 2. Command Handler
case "$1" in
  load)
    echo "Loading LaunchAgent..."
    launchctl bootstrap "gui/$(id -u)" "${PLIST}"
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
    echo "Usage: DOMAIN=example.com $0 {load|unload|restart|status}"
    exit 1
    ;;
esac