#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo "Linux required" >&2; exit 2; }
ACTION="${1:---print}"
ROOT="${BRIDGE_INSTALL_ROOT:-/home/agent-bridge}"
[[ "${ROOT}" == /* && "${ROOT}" != *$'\n'* ]] || { echo "BRIDGE_INSTALL_ROOT must be an absolute path without newlines" >&2; exit 2; }
# Wrap systemd values to preserve spaces and literal unit specifiers.
quote_unit() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "${value}"
}
USER_NAME=bridge
BRIDGE_HOME="${BRIDGE_USER_HOME:-$(getent passwd "${USER_NAME}" 2>/dev/null | cut -d: -f6 || true)}"
BRIDGE_HOME="${BRIDGE_HOME:-/home/agent-bridge}"
ROOT_Q="$(quote_unit "${ROOT}")"
HOME_Q="$(quote_unit "HOME=${BRIDGE_HOME}")"
VOLTA_Q="$(quote_unit "VOLTA_HOME=${BRIDGE_HOME}/.volta")"
UNIT=/etc/systemd/system/agent-bridge.service
PATH_Q="$(quote_unit "PATH=${BRIDGE_HOME}/.volta/bin:${BRIDGE_HOME}/.bun/bin:${BRIDGE_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")"
SCRIPT_Q="$(quote_unit "${ROOT}/scripts/with-env.sh")"
UNIT_TEXT="[Unit]
Description=Agent Bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${USER_NAME}
Group=${USER_NAME}
WorkingDirectory=${ROOT_Q}
Environment=${HOME_Q}
Environment=${VOLTA_Q}
Environment=${PATH_Q}
Environment=NODE_ENV=production
ExecStart=/usr/bin/bash ${SCRIPT_Q} bridge
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-bridge

[Install]
WantedBy=multi-user.target"
case "${ACTION}" in
  --print) printf '%s\n' "${UNIT_TEXT}";;
  --install|--replace)
    (( EUID == 0 )) || { echo "Administrative privileges required for installing a system unit" >&2; exit 1; }
    [[ -f "${ROOT}/scripts/with-env.sh" && -f "${ROOT}/linear-agent-bridge/agent-bridge.mjs" ]] || {
      echo "Missing production checkout at ${ROOT}" >&2; exit 1;
    }
    # The bridge runtime reads PROJECTS_ROOT from .env, rather than assuming
    # that coding workspaces live beneath its production checkout.
    ENV_FILE="${LINEAR_AGENTS_ENV_FILE:-${ROOT}/.env}"
    [[ -r "${ENV_FILE}" ]] || { echo "Missing readable ${ENV_FILE}" >&2; exit 1; }
    if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?PROJECTS_ROOT=[^[:space:]#]+' "${ENV_FILE}"; then
      echo "Set PROJECTS_ROOT in ${ENV_FILE} before installation" >&2; exit 1
    fi
    if [[ -e "${UNIT}" ]]; then
      [[ "${ACTION}" == --replace ]] || { echo "${UNIT} exists; not overwriting" >&2; exit 1; }
      cp -p "${UNIT}" "${UNIT}.backup.$(date +%Y%m%d-%H%M%S)"
    fi
    printf '%s\n' "${UNIT_TEXT}" > "${UNIT}"
    chmod 644 "${UNIT}"
    systemd-analyze verify "${UNIT}"
    systemctl daemon-reload
    echo "Installed ${UNIT}; NOT restarted or enabled."
    ;;
  *) echo "Usage: $0 {--print|--install|--replace}" >&2; exit 2 ;;
esac
