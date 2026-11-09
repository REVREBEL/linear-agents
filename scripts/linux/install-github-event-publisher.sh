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
SERVICE=/etc/systemd/system/agent-bridge-github-events.service
TIMER=/etc/systemd/system/agent-bridge-github-events.timer
PATH_Q="$(quote_unit "PATH=${BRIDGE_HOME}/.volta/bin:${BRIDGE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin")"
SCRIPT_Q="$(quote_unit "${ROOT}/scripts/linux/run-github-event-publisher.sh")"
SERVICE_TEXT="[Unit]
Description=Publish sanitized Agent Bridge GitHub event journal
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=bridge
Group=bridge
WorkingDirectory=${ROOT_Q}
Environment=${HOME_Q}
Environment=${VOLTA_Q}
Environment=${PATH_Q}
ExecStart=/usr/bin/bash ${SCRIPT_Q}
UMask=0077
NoNewPrivileges=true
PrivateTmp=true"
TIMER_TEXT="[Unit]
Description=Run Agent Bridge GitHub event publisher every 15 minutes

[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min
Persistent=true
Unit=agent-bridge-github-events.service

[Install]
WantedBy=timers.target"
case "${ACTION}" in
  --print) printf '%s\n\n%s\n' "${SERVICE_TEXT}" "${TIMER_TEXT}";;
  --install|--replace)
    (( EUID == 0 )) || { echo "Administrative privileges required" >&2; exit 1; }
    [[ -f "${ROOT}/scripts/publish-github-events.mjs" && -f "${ROOT}/scripts/linux/run-github-event-publisher.sh" ]] || {
      echo "Missing publisher checkout at ${ROOT}" >&2; exit 1;
    }
    for file in "${SERVICE}" "${TIMER}"; do
      if [[ -e "${file}" && "${ACTION}" != --replace ]]; then
        echo "${file} exists; refusing to overwrite" >&2; exit 1;
      fi
    done
    for file in "${SERVICE}" "${TIMER}"; do
      if [[ -e "${file}" ]]; then cp -p "${file}" "${file}.backup.$(date +%Y%m%d-%H%M%S)"; fi
    done
    printf '%s\n' "${SERVICE_TEXT}" > "${SERVICE}"
    printf '%s\n' "${TIMER_TEXT}" > "${TIMER}"
    chmod 644 "${SERVICE}" "${TIMER}"
    systemd-analyze verify "${SERVICE}" "${TIMER}"
    systemctl daemon-reload
    echo "Installed systemd timer. NOT enabled: use systemctl enable --now agent-bridge-github-events.timer after reviewing Git push credentials."
    ;;
  *) echo "Usage: $0 {--print|--install|--replace}" >&2; exit 2 ;;
esac
