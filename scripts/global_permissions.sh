#!/usr/bin/env bash
# REVREBEL /opt shared tool permissions (Ubuntu)
# Applies ONLY to the configured TARGETS directories; /opt/agents descendants are private.
# Does not touch user HOME files, shells, application services, or unrelated /opt paths.
set -Eeuo pipefail

# ==== Configuration ===========================================================
# Relative directory names under /opt. Add future shared-tool folders here.
# Re-running --apply reconciles permissions for all listed directories.
# Keep "agents" in the list only if you want its PARENT ACL managed; agent
# profiles beneath /opt/agents are deliberately never processed recursively.
TARGETS=(agents agent-tools bun scripts uv venv volta zsh_config)
# ============================================================================

usage() {
  cat <<'HELP'
Usage: bash finalize-opt-shared-access.sh --dry-run | --apply [--install-auto]
       bash finalize-opt-shared-access.sh --sync-users-only

--dry-run          Show intended changes; do not alter accounts or filesystem.
--apply            Sync local accounts to bridge-usr and apply tool ACLs.
--install-auto     With --apply, install a 5-minute systemd timer for NEW local accounts.
--sync-users-only  Enroll missing local accounts (for systemd timer; no ACL changes).

bridge-usr: read + execute to shared tools; never group write.
bridge-adm: read + write + execute to shared tools.
bridge: supplemental memberships bridge-usr, bridge-adm and adm.
Configured targets: edit TARGETS near the top of this script; --apply rebases ACLs.
/opt/agents: only the root folder gets access ACLs. Its child profiles remain untouched.
HELP
}

MODE=''
AUTO=0
for arg in "${@}"; do
  case "${arg}" in
    --dry-run|--apply|--sync-users-only)
      [[ -z "${MODE}" ]] || { echo 'Choose exactly one mode' >&2; exit 2; }
      MODE="${arg}" ;;
    --install-auto) AUTO=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "${MODE}" ]] || { usage >&2; exit 2; }
if (( AUTO )) && [[ "${MODE}" != --apply ]]; then
  echo '--install-auto requires --apply' >&2; exit 2
fi
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
for cmd in getent groupadd usermod id setfacl getfacl find stat; do
  command -v "${cmd}" >/dev/null || { echo "Missing required command: ${cmd}" >&2; exit 1; }
done

# Validate configured scope before applying permissions.
for name in "${TARGETS[@]}"; do
  path="/opt/${name}"
  [[ -d "${path}" && ! -L "${path}" ]] || { echo "Unsafe or missing directory: ${path}" >&2; exit 1; }
done

# Only LOCAL accounts (/etc/passwd): directory-service and dynamic users are not covered.
mapfile -t LOCAL_USERS < <(awk -F: 'NF>=7 && $1 != "" {print $1}' /etc/passwd)
[[ ${#LOCAL_USERS[@]} -gt 0 ]] || { echo 'No local accounts found' >&2; exit 1; }

run() {
  if [[ "${MODE}" == --dry-run ]]; then
    printf '[DRY RUN]'; printf ' %q' "${@}"; printf '\n'
  else
    "${@}"
  fi
}
ensure_group() {
  local group="${1}"
  if ! getent group "${group}" >/dev/null; then
    run groupadd -- "${group}"
  fi
}
ensure_member() {
  local user="${1}" group="${2}"
  if [[ "${MODE}" == --dry-run ]] && ! getent group "${group}" >/dev/null; then
    run usermod -aG "${group}" "${user}"; return
  fi
  if ! id -nG "${user}" | tr ' ' '\n' | grep -Fxq -- "${group}"; then
    run usermod -aG "${group}" "${user}"
  fi
}

ensure_group bridge-usr
ensure_group bridge-adm
getent group adm >/dev/null || { echo 'Ubuntu adm group missing: refusing to create it' >&2; exit 1; }
id bridge >/dev/null || { echo 'Existing bridge account missing' >&2; exit 1; }
for user in "${LOCAL_USERS[@]}"; do
  ensure_member "${user}" bridge-usr
done
ensure_member bridge bridge-adm
ensure_member bridge adm

echo "Account sync processed ${#LOCAL_USERS[@]} local users."
[[ "${MODE}" == --sync-users-only ]] && exit 0

echo 'Applying group ACLs. Existing file owners, modes, and other ACL entries are not reset.'
for name in "${TARGETS[@]}"; do
  path="/opt/${name}"
  if [[ "${name}" == agents ]]; then
    echo "Private boundary: ${path} only (no recursion into profiles)"
    run setfacl -m g:bridge-usr:r-x,g:bridge-adm:rwx,m::rwx -- "${path}"
    # No default ACL: newly created agent profiles do NOT inherit group access.
  else
    echo "Shared tool directory: ${path} (recursive ACL + directory defaults)"
    run setfacl -R -m g:bridge-usr:r-X,g:bridge-adm:rwX -- "${path}"
    # Default ACLs apply only to future children, not to /opt itself.
    if [[ "${MODE}" == --dry-run ]]; then
      echo "[DRY RUN] find ${path} -type d -exec setfacl -m d:g:bridge-usr:r-x,d:g:bridge-adm:rwx {} +"
    else
      find "${path}" -type d -exec setfacl -m d:g:bridge-usr:r-x,d:g:bridge-adm:rwx {} +
    fi
  fi
done

# ==== Verify shared directory ACLs ==========================================
echo 'Verifying effective ACLs on representative paths.'

VERIFY_PATHS=(
  /opt/volta/bin
  /opt/agent-tools/bin/opencode
  /opt/agents
  /opt/agents/opencode
)

for path in "${VERIFY_PATHS[@]}"; do
  if [[ -e "${path}" ]]; then
    echo "=== ${path} ==="
    getfacl -p -- "${path}"
  else
    echo "SKIP: ${path} does not exist"
  fi
done
# ============================================================================

if (( AUTO )); then
  # Keep the existing automatic synchronization code here.
  # Keep its existing closing fi.

  command -v systemctl >/dev/null || { echo 'systemctl not found' >&2; exit 1; }
  command -v install >/dev/null || { echo 'install not found' >&2; exit 1; }
  path=/usr/local/sbin/bridge-user-sync
  source_path="$(readlink -f -- "${0}")"
  [[ -f "${source_path}" ]] || { echo 'Run from a regular on-disk script' >&2; exit 1; }
  # Install a stable copy so the timer works after deleting the extracted bundle.
  run install -o root -g root -m 0755 -- "${source_path}" "${path}"
  if [[ "${MODE}" != --dry-run ]]; then
    cat >/etc/systemd/system/bridge-user-sync.service <<'UNIT'
[Unit]
Description=Enroll local Linux accounts in bridge-usr
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bridge-user-sync --sync-users-only
UNIT
    cat >/etc/systemd/system/bridge-user-sync.timer <<'UNIT'
[Unit]
Description=Reconcile local account memberships for shared /opt tooling
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable --now bridge-user-sync.timer
  fi
fi

echo 'Complete. No home directories, login shells, unrelated /opt directories, or services changed.'
echo 'Note: existing processes may require a restart/login to acquire new supplementary groups.'
