#!/usr/bin/env bash
# REVREBEL centralized agent/tool home symlinks.
# Preserves existing home entries unless --archive-existing is explicitly chosen.
# Never modifies the ownership or permissions of shared source directories.
set -Eeuo pipefail
IFS=$'\n\t'

# === Configuration (same conventions as global_shared.sh) ===================
HOME_ROOT="$HOME"                     # Informational only; getent resolves each user's home
TARGET_USERS=(root rebel bridge n8n)
DRY_RUN=0
LOG_FILE=''
GLOBAL_TOOLS_DIR=/opt/global-tools
AGENTS_DIR=/opt/agents
AGENTS_TOOLS=/opt/agent-tools
ARCHIVE_EXISTING=0
# ============================================================================
usage() {
  cat <<'HELP'
Usage: bash link-agent-homes.sh [--dry-run] [--archive-existing] [--log PATH]
  --dry-run           Preview all changes without applying them.
  --archive-existing  Preserve existing entries as NAME_archived_N, then link.
                      Stop dependent services first, particularly PM2.
  --log PATH          Log output (default /var/log/agent-home-links-...).
  -h, --help          Display help.

Every symlink is owned by its local account, using chown -h. The shared
target's ownership and ACLs are never changed. Existing files/directories/
wrong symlinks are skipped unless --archive-existing is supplied.
Missing shared source directories are skipped. No credentials are migrated.
No ~/.zshenv files are read or changed. HOME_ROOT is informational; each
user's real home is resolved through getent passwd.
HELP
}
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --archive-existing) ARCHIVE_EXISTING=1; shift ;;
    --log)
      (( $# >= 2 )) || { echo 'Missing --log path' >&2; exit 2; }
      LOG_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
for cmd in getent readlink mv ln install tee chown date; do
  command -v "$cmd" >/dev/null || { printf 'Missing command: %s\n' "$cmd" >&2; exit 1; }
done
if [[ -z "$LOG_FILE" ]]; then
  if (( DRY_RUN )); then
    LOG_FILE="/tmp/agent-home-links-dry-run-$(date +%Y%m%d-%H%M%S)-$$.log"
  else
    LOG_FILE="/var/log/agent-home-links-$(date +%Y%m%d-%H%M%S)-$$.log"
  fi
fi
install -d -m 0755 -- "$(dirname -- "$LOG_FILE")"
touch -- "$LOG_FILE"
chmod 0600 -- "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
error() { printf '[ERROR] %s\n' "$*" >&2; }
run() {
  if (( DRY_RUN )); then
    printf '[DRY RUN]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}
# Name/source arrays have exactly matching indices.
# .cargo -> cargo corrects the obvious .cargo -> bun mapping typo.
# Only .agents belongs under AGENTS_TOOLS. Other shared tools are in GLOBAL_TOOLS_DIR.
LINK_NAMES=(
  .codex .gemini .kilo .vibe .openchamber .opencode .qwen
  .agents
  .bun .cargo .go .npm .pm2 .snap .uv .venv .volta .yarn
)
LINK_SOURCES=(
  "$AGENTS_DIR/codex/.codex"
  "$AGENTS_DIR/gemini/.gemini"
  "$AGENTS_DIR/kilo/.kilo"
  "$AGENTS_DIR/minstral/.vibe"
  "$AGENTS_DIR/openchamber"
  "$AGENTS_DIR/opencode"
  "$AGENTS_DIR/qwen/.qwen"
  "$AGENTS_TOOLS/agents"
  "$GLOBAL_TOOLS_DIR/bun"
  "$GLOBAL_TOOLS_DIR/cargo"
  "$GLOBAL_TOOLS_DIR/go"
  "$GLOBAL_TOOLS_DIR/npm"
  "$GLOBAL_TOOLS_DIR/pm2"
  "$GLOBAL_TOOLS_DIR/snap"
  "$GLOBAL_TOOLS_DIR/uv"
  "$GLOBAL_TOOLS_DIR/venv"
  "$GLOBAL_TOOLS_DIR/volta"
  "$GLOBAL_TOOLS_DIR/yarn"
)
[[ "${#LINK_NAMES[@]}" == "${#LINK_SOURCES[@]}" ]] || {
  error 'Mapping name/source counts differ'; exit 1;
}
for parent in "$GLOBAL_TOOLS_DIR" "$AGENTS_DIR" "$AGENTS_TOOLS"; do
  [[ "$parent" == /* && "$parent" != / && -d "$parent" && ! -L "$parent" ]] || {
    error "Invalid or missing shared root: $parent"; exit 1;
  }
done
link_managed() {
  local src="$1" dest="$2" uid="$3" gid="$4"
  local parent="${dest%/*}" base="${dest##*/}" backup n
  if [[ ! -d "$src" ]]; then
    warn "Missing source, skipping: $dest -> $src"
    return 0
  fi
  if [[ -L "$dest" && "$(readlink -- "$dest")" == "$src" ]]; then
    info "Already linked: $dest"
    run chown -h -- "$uid:$gid" "$dest"
    return 0
  fi
  if [[ -e "$dest" || -L "$dest" ]]; then
    if (( ! ARCHIVE_EXISTING )); then
      warn "Existing home entry preserved: $dest (use --archive-existing only after checking services)"
      return 0
    fi
    n=1
    while :; do
      backup="$parent/${base}_archived_$n"
      [[ -e "$backup" || -L "$backup" ]] || break
      ((n+=1))
    done
    info "Archive existing: $dest -> $backup"
    run mv -- "$dest" "$backup"
  fi
  info "Link $dest -> $src"
  run ln -s -- "$src" "$dest"
  # chown -h changes the link inode only, NOT the shared source.
  run chown -h -- "$uid:$gid" "$dest"
}
info "Invoking HOME_ROOT=$HOME_ROOT; shared roots: $AGENTS_DIR $AGENTS_TOOLS $GLOBAL_TOOLS_DIR"
for user in "${TARGET_USERS[@]}"; do
  entry="$(getent passwd -- "$user")" || { error "Missing account: $user"; exit 1; }
  IFS=: read -r _ _ uid gid _ home shell <<< "$entry"
  [[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] || {
    error "Unsafe or unavailable home for $user: $home"; exit 1;
  }
  info "Account $user: home=$home uid=$uid gid=$gid shell=$shell"
  for i in "${!LINK_NAMES[@]}"; do
    link_managed "${LINK_SOURCES[i]}" "$home/${LINK_NAMES[i]}" "$uid" "$gid"
  done
done
info 'Complete. Shared targets and ~/.zshenv were not changed.'
info "Log: $LOG_FILE"
