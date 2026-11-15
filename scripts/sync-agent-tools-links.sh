#!/usr/bin/env bash
# Synchronize /usr/local/bin symlinks to executables found in bin directories
# under a centrally installed tool tree. Never modifies the source tree.
set -Eeuo pipefail

# ==== Configuration ==========================================================
SOURCE_ROOT='/opt/agent-tools'
TARGET_BIN='/usr/local/bin'
# ============================================================================

DRY_RUN=0
REPLACE_FOREIGN_LINKS=0

usage() {
  cat <<'HELP'
Usage: sync-agent-tools-links.sh [--dry-run] [--replace-foreign-links] [--help]

Find executable files and executable symlinks immediately inside every directory
named bin under SOURCE_ROOT, including SOURCE_ROOT/bin. Link each command name
into TARGET_BIN.

By default:
  - Create missing links.
  - Leave correct links unchanged.
  - Fix links whose current symlink target is inside SOURCE_ROOT, including stale
    links to a different agent-tools bin directory.
  - SKIP existing regular files, directories, and symlinks outside SOURCE_ROOT.
  - SKIP duplicate command names discovered in different bin directories.
  - Do not delete stale TARGET_BIN links or alter SOURCE_ROOT.

--dry-run                Print intended operations without writing.
--replace-foreign-links  Archive existing foreign symlinks and point them to
                         SOURCE_ROOT instead. Never replace regular files.
HELP
}

while (($#)); do
  case "${1}" in
    --dry-run) DRY_RUN=1; shift ;;
    --replace-foreign-links) REPLACE_FOREIGN_LINKS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "${1}" >&2; usage >&2; exit 2 ;;
  esac
done

(( EUID == 0 )) || { printf 'Run as root.\n' >&2; exit 1; }
[[ -d "${SOURCE_ROOT}" && ! -L "${SOURCE_ROOT}" ]] || {
  printf 'Missing or unsafe source directory: %s\n' "${SOURCE_ROOT}" >&2
  exit 1
}
[[ -d "${TARGET_BIN}" && ! -L "${TARGET_BIN}" ]] || {
  printf 'Missing or unsafe target directory: %s\n' "${TARGET_BIN}" >&2
  exit 1
}
for cmd in find sort readlink ln mv dirname basename; do
  command -v "${cmd}" >/dev/null || { printf 'Missing command: %s\n' "${cmd}" >&2; exit 1; }
done

# Canonical absolute root; ensures prefix checks cannot confuse another prefix.
SOURCE_ROOT="$(cd -- "${SOURCE_ROOT}" && pwd -P)"
TARGET_BIN="$(cd -- "${TARGET_BIN}" && pwd -P)"

is_inside_source() {
  local candidate="${1}" resolved
  # Links may be broken; avoid realpath requirements and compare lexical symlink
  # destinations first. For correct paths, canonicalize with readlink -f.
  case "${candidate}" in
    "${SOURCE_ROOT}"/*) return 0 ;;
  esac
  resolved="$(readlink -f -- "${candidate}" 2>/dev/null || true)"
  [[ "${resolved}" == "${SOURCE_ROOT}/"* ]]
}

backup_link() {
  local target="${1}" backup suffix=1
  while :; do
    backup="${target}.archived_${suffix}"
    [[ -e "${backup}" || -L "${backup}" ]] || break
    ((suffix+=1))
  done
  if (( DRY_RUN )); then
    printf '  DRY RUN archive: %s -> %s\n' "${target}" "${backup}"
  else
    mv -- "${target}" "${backup}"
    printf '  archived: %s\n' "${backup}"
  fi
}

link_command() {
  local source="${1}" target="${2}" old_target
  if [[ -L "${target}" ]]; then
    old_target="$(readlink -- "${target}")"
    if [[ "${old_target}" == "${source}" ]]; then
      printf 'OK     %s\n' "${target}"
      return 0
    fi
    if is_inside_source "${old_target}"; then
      printf 'UPDATE %s: %s -> %s\n' "${target}" "${old_target}" "${source}"
    elif (( REPLACE_FOREIGN_LINKS )); then
      printf 'REPLACE FOREIGN LINK %s: %s -> %s\n' "${target}" "${old_target}" "${source}"
      backup_link "${target}"
      if (( DRY_RUN )); then
        printf '  DRY RUN link: %s -> %s\n' "${target}" "${source}"
        return 0
      fi
      ln -s -- "${source}" "${target}"
      return 0
    else
      printf 'SKIP   %s (symlink points outside %s: %s)\n' "${target}" "${SOURCE_ROOT}" "${old_target}"
      return 0
    fi
    if (( DRY_RUN )); then
      printf '  DRY RUN relink: %s -> %s\n' "${target}" "${source}"
    else
      # Preserve the old link under a backup name in case a former configuration
      # intentionally referenced a different agent-tools executable.
      backup_link "${target}"
      ln -s -- "${source}" "${target}"
    fi
  elif [[ -e "${target}" ]]; then
    printf 'SKIP   %s (existing non-symlink; never overwrite)\n' "${target}"
  else
    printf 'CREATE %s -> %s\n' "${target}" "${source}"
    if (( ! DRY_RUN )); then
      ln -s -- "${source}" "${target}"
    fi
  fi
}

# Paths discovered through find are NUL delimited to support whitespace.
# Avoid following symlinked directories (find default -P) and scan only the
# direct entries of each bin directory, not its nested package internals.
declare -A SEEN=()
FOUND=0
while IFS= read -r -d '' bin_dir; do
  printf 'Scanning: %s\n' "${bin_dir}"
  while IFS= read -r -d '' source; do
    [[ -f "${source}" && -x "${source}" ]] || continue
    name="$(basename -- "${source}")"
    # A command name must be a simple filename and not an option-like name.
    [[ "${name}" != -* ]] || { printf 'SKIP   unusual executable name: %s\n' "${source}"; continue; }
    if [[ -v "SEEN[${name}]" ]]; then
      printf 'SKIP   duplicate command %s: %s (first: %s)\n' "${name}" "${source}" "${SEEN[${name}]}"
      continue
    fi
    SEEN["${name}"]="${source}"
    ((FOUND+=1))
    link_command "${source}" "${TARGET_BIN}/${name}"
  done < <(find "${bin_dir}" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -print0 | sort -z)
done < <(find "${SOURCE_ROOT}" -type d -name bin -print0 | sort -z)

printf 'Discovered %s unique executable command(s). %s\n' "${FOUND}" "$([[ "${DRY_RUN}" -eq 1 ]] && printf 'No changes made.' || printf 'Synchronization complete.')"
