#!/usr/bin/env bash
# REVREBEL shared Zsh/Nano/Starship links for existing Ubuntu accounts.
# Deliberately never reads, creates, writes, chmods, or chowns ~/.zshenv.
# Deliberately does not modify account login shells, groups, or /opt tool ACLs.
set -Eeuo pipefail
IFS=$'\n\t'

CONFIG_ROOT='/opt/zsh_config'
TARGET_USERS=(root rebel bridge n8n)
DRY_RUN=0
MANAGE_GLOBAL_ZSHENV=0  # Explicit opt-in only: --link-global-zshenv
LOG_FILE=''

usage() {
  cat <<'HELP'
Usage: bash global_shared_corrected.sh [--dry-run] [--link-global-zshenv] [--log PATH]

Default behavior:
  * Detect installed zsh, nano and starship executables.
  * For accounts whose EXISTING login shell is Zsh, link ~/.zshrc to
    /opt/zsh_config/zshrc_linux when Zsh is installed.
  * When Nano is installed, link ~/.nanorc to /opt/zsh_config/nanorc.
  * When Starship is installed, link ~/.config/starship to
    /opt/zsh_config/starship (a directory).
  * Archive existing link destinations before replacement.

No ~/.zshenv files are read or modified. No EDITOR/VISUAL exports are added.
No shells, groups, ownership/ACLs under /opt, or running services are changed.

Options:
  --dry-run              Show changes without making them
  --link-global-zshenv   Explicitly opt into managing /etc/zsh/zshenv
                         (existing file is archived before linking)
  --log PATH             Save log (default: /var/log/shared-shell-...)
  -h, --help             Show help
HELP
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --link-global-zshenv) MANAGE_GLOBAL_ZSHENV=1; shift ;;
    --log)
      (($# >= 2)) || { printf 'Missing argument to --log\n' >&2; exit 2; }
      LOG_FILE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

(( EUID == 0 )) || { printf 'ERROR: Run this script as root.\n' >&2; exit 1; }
if [[ -z "${LOG_FILE}" ]]; then
  if (( DRY_RUN )); then
    LOG_FILE="/tmp/shared-shell-dry-run-$(date +%Y%m%d-%H%M%S)-$$.log"
  else
    LOG_FILE="/var/log/shared-shell-$(date +%Y%m%d-%H%M%S)-$$.log"
  fi
fi
install -d -m 0755 -- "$(dirname -- "${LOG_FILE}")"
touch -- "${LOG_FILE}"
chmod 0600 -- "${LOG_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
error() { printf '[ERROR] %s\n' "$*" >&2; }
run() {
  if (( DRY_RUN )); then
    printf '[DRY RUN]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Safely archive an existing destination. Never touch the source of a symlink.
# Idempotent: existing correct links are left unchanged.
link_managed() {
  local src=$1 dest=$2 uid=$3 gid=$4 dir base backup n
  dir=${dest%/*}
  base=${dest##*/}
  [[ -e "${src}" ]] || { warn "Shared source absent, skipping: ${src}"; return 0; }

  # Existing correct symlink: no changes to source or link ownership.
  if [[ -L "${dest}" && "$(readlink -- "${dest}")" == "${src}" ]]; then
    info "Already linked: ${dest}"
    return 0
  fi

  # Do not write into a home-relative parent that resolves outside user's home.
  # A user-controlled ~/.config symlink is not automatically trusted.
  if [[ "${base}" == starship && -L "$dir" ]]; then
    warn "Refusing to manage ${dest}: parent .config is a symlink"
    return 0
  fi

  if [[ -e "${dest}" || -L "${dest}" ]]; then
    n=1
    while :; do
      backup="$dir/${base}_archived_$n"
      [[ -e "${backup}" || -L "${backup}" ]] || break
      ((n+=1))
    done
    info "Archive existing: ${dest} -> ${backup}"
    run mv -- "${dest}" "${backup}"
  fi
  # The parent home exists; create only the .config container when needed.
  if [[ "${base}" == starship && ! -d "$dir" ]]; then
    run install -d -o "${uid}" -g "${gid}" -m 0700 -- "$dir"
  fi
  info "Link ${dest} -> ${src}"
  run ln -s -- "${src}" "${dest}"
  if (( ! DRY_RUN )); then
    chown -h -- "${uid}:${gid}" "${dest}"
  fi
}

for cmd in getent readlink mv ln install tee chown; do
  command -v "${cmd}" >/dev/null || { error "Required utility not found: ${cmd}"; exit 1; }
done

ZSH_BIN=$(command -v zsh || true)
NANO_BIN=$(command -v nano || true)
STARSHIP_BIN=$(command -v starship || true)
info "Detected zsh=${ZSH_BIN:-absent}, nano=${NANO_BIN:-absent}, starship=${STARSHIP_BIN:-absent}"
[[ -d "${CONFIG_ROOT}" ]] || { error "Missing shared config directory ${CONFIG_ROOT}"; exit 1; }

for user in "${TARGET_USERS[@]}"; do
  entry=$(getent passwd "${user}") || { error "Missing required account: ${user}"; exit 1; }
  IFS=: read -r _ _ uid gid _ home shell <<< "$entry"
  [[ "${home}" == /* && "${home}" != / && -d "${home}" && ! -L "${home}" ]] || {
    error "Unsafe or unavailable home for ${user}: ${home}"; exit 1;
  }
  info "Account ${user} (home=${home}; login shell=${shell})"

  if [[ -n "${ZSH_BIN}" ]]; then
    if [[ "${shell##*/}" == zsh ]]; then
      link_managed "${CONFIG_ROOT}/zshrc_linux" "${home}/.zshrc" "${uid}" "${gid}"
    else
      info "Skipping .zshrc: ${user} does not have Zsh as its login shell (no shell changes)"
    fi
  fi
  if [[ -n "${NANO_BIN}" ]]; then
    link_managed "${CONFIG_ROOT}/nanorc" "${home}/.nanorc" "${uid}" "${gid}"
  fi
  if [[ -n "${STARSHIP_BIN}" ]]; then
    link_managed "${CONFIG_ROOT}/starship" "${home}/.config/starship" "${uid}" "${gid}"
  fi
done

if (( MANAGE_GLOBAL_ZSHENV )); then
  if [[ -z "${ZSH_BIN}" ]]; then
    warn 'Global zshenv option requested but Zsh is not installed; skipped.'
  else
    # Global handling is opt-in, independent of per-user ~/.zshenv handling.
    link_managed "${CONFIG_ROOT}/zshrc_global_linux" /etc/zsh/zshenv 0 0
  fi
else
  info 'Global /etc/zsh/zshenv untouched (explicit opt-in required).'
fi
info 'Complete. All per-user ~/.zshenv files left untouched.'
info 'No group memberships, recursive ownership, or tool directory ACLs changed.'
info "Log: ${LOG_FILE}"
