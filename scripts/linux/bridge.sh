#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo "Ubuntu/Linux required" >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SERVICE=agent-bridge
load_env() {
  local file="${LINEAR_AGENTS_ENV_FILE:-${ROOT}/.env}"
  [[ -r "${file}" ]] || { echo "Missing readable ${file}" >&2; return 1; }
  set -a
  # shellcheck disable=SC1090
  source "${file}"
  set +a
}
service_control() {
  if (( EUID == 0 )); then
    systemctl "$1" "${SERVICE}"
  else
    # Run only the authorized operation on the exact service unit.
    sudo -n systemctl "$1" "${SERVICE}"
  fi
}
case "${1:-}" in
  load|start) service_control start ;;
  unload|stop) service_control stop ;;
  restart) service_control restart ;;
  enable) service_control enable ;;
  disable) service_control disable ;;
  status)
    load_env
    systemctl status "${SERVICE}" --no-pager || true
    printf '\n=== Bridge health ===\n'
    host="${BRIDGE_HOST:-127.0.0.1}"
    port="${BRIDGE_PORT:-8788}"
    [[ "${port}" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "Invalid BRIDGE_PORT" >&2; exit 2; }
    # Curl handles IPv6 literals inside brackets; reject non-local diagnostic hosts.
    case "${host}" in
      127.0.0.1|localhost|::1) ;;
      *) echo "Refusing to probe a non-loopback BRIDGE_HOST: ${host}" >&2; exit 2 ;;
    esac
    [[ "${host}" == *:* ]] && host="[${host}]"
    curl --fail --silent --show-error --max-time 5 "http://${host}:${port}/health"
    printf '\n'
    ;;
  doctor)
    load_env
    exec node "${ROOT}/scripts/bridge-doctor.mjs"
    ;;
  *)
    echo "Usage: $0 {load|unload|start|stop|restart|enable|disable|status|doctor}" >&2
    exit 2
    ;;
esac
