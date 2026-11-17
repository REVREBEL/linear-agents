#!/usr/bin/env bash
# REVREBEL /opt shared ownership and permission reconciliation.
# Shared tools are bridge:bridge-adm; all users may read/traverse/execute.
# Named local accounts share native agent profiles, including existing state.
set -Eeuo pipefail
IFS=$'\n\t'

GLOBAL_TOOLS_DIR=/opt/global-tools
AGENTS_DIR=/opt/agents
AGENTS_TOOLS=/opt/agent-tools
SCRIPTS_DIR=/opt/scripts
ZSH_CONFIG_DIR=/opt/zsh_config
OWNER=bridge
ADMIN_GROUP=bridge-adm
TARGET_USERS=(root rebel bridge n8n)
MODE=''
DRY_RUN=0
LOG_FILE=''
SHARE_AGENT_PROFILES=1
TOOL_DIRS=(bun cargo go npm pm2 snap uv venv volta yarn)
# Only directories are managed in the toolchain; package files remain untouched.

usage() {
  cat <<'HELP'
Usage: sudo bash global_permissions.sh --dry-run [--no-agent-profiles] [--log FILE]
       sudo bash global_permissions.sh --apply [--no-agent-profiles] [--log FILE]
       sudo bash global_permissions.sh --sync-users-only

--dry-run             Show changes without applying permissions.
--apply               Reconcile shared install/script ownership and modes.
--share-agent-profiles Backward-compatible explicit enable (now default).
--no-agent-profiles   Skip shared profile ACL reconciliation.
--sync-users-only     Legacy timer compatibility; no-op. New account group
                       enrollment is unnecessary for universal read/execute.
--log FILE            Log output to FILE.

Shared tool operations manage only installation/container directories.
Installed packages, caches, config, PM2 state and Git data stay untouched.
Native profiles are intentionally shared by designated accounts, including
sessions, credentials and temporary state. Protect them accordingly.
HELP
}
while (( $# )); do
  case "$1" in
    --dry-run|--apply|--sync-users-only)
      [[ -z "$MODE" ]] || { echo 'Choose exactly one mode' >&2; exit 2; }
      MODE="$1"; shift ;;
    --share-agent-profiles) SHARE_AGENT_PROFILES=1; shift ;;
    --no-agent-profiles) SHARE_AGENT_PROFILES=0; shift ;;
    --log)
      (( $# >= 2 )) || { echo '--log requires an argument' >&2; exit 2; }
      LOG_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { usage >&2; exit 2; }
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
for tool in getent stat find chown chmod setfacl getfacl tee install; do
  command -v "$tool" >/dev/null || { echo "Missing required executable: $tool" >&2; exit 1; }
done
getent passwd "$OWNER" >/dev/null || { echo "Missing owner: $OWNER" >&2; exit 1; }
getent group "$ADMIN_GROUP" >/dev/null || { echo "Missing group: $ADMIN_GROUP" >&2; exit 1; }
for user in "${TARGET_USERS[@]}"; do
  getent passwd "$user" >/dev/null || { echo "Missing user: $user" >&2; exit 1; }
done
if [[ "$MODE" == --sync-users-only ]]; then
  echo 'No-op: legacy local-user sync timer; all-user bridge-usr enrollment disabled.'
  exit 0
fi
[[ "$MODE" == --dry-run ]] && DRY_RUN=1
if [[ -z "$LOG_FILE" ]]; then
  if (( DRY_RUN )); then
    LOG_FILE="/tmp/global-permissions-dry-run-$(date +%Y%m%d-%H%M%S)-$$.log"
  else
    LOG_FILE="/var/log/global-permissions-$(date +%Y%m%d-%H%M%S)-$$.log"
  fi
fi
install -d -m 0755 -- "$(dirname -- "$LOG_FILE")"
touch -- "$LOG_FILE"
chmod 0600 -- "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
run() {
  if (( DRY_RUN )); then
    printf '[DRY RUN]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
assert_shared_root() {
  local path="$1"
  [[ "$path" == /opt/* && "$path" != /opt && -d "$path" && ! -L "$path" ]] || {
    printf '[ERROR] Unsafe/missing directory: %s\n' "$path" >&2
    exit 1
  }
}
apply_dir() {
  local path="$1"
  run chown -- "$OWNER:$ADMIN_GROUP" "$path"
  run chmod -- 2775 "$path"
  # Refresh effective group permission where previous ACLs remain installed,
  # without erasing unrelated access-control entries.
  if (( ! DRY_RUN )) && getfacl -cp -- "$path" | grep -q '^group:'; then
    run setfacl -m "g:$ADMIN_GROUP:rwx,m::rwx" -- "$path"
  fi
}
# Only correct the shared entrypoint directories. Do not recursively chown or
# chmod package files: Cargo registries, Volta images, Go modules and Yarn
# dependencies frequently contain intentionally managed metadata.
shared_entry() {
  local path="$1"
  if [[ ! -d "$path" || -L "$path" ]]; then
    warn "Missing or symlinked shared directory, skipping: $path"
    return
  fi
  info "Shared entrypoint: $path"
  apply_dir "$path"
}
shared_entry "$GLOBAL_TOOLS_DIR"
for name in "${TOOL_DIRS[@]}"; do
  shared_entry "$GLOBAL_TOOLS_DIR/$name"
done
shared_entry "$AGENTS_TOOLS"
shared_entry "$SCRIPTS_DIR"
# Selected executable entrypoint directories only, not their file contents.
for path in "$GLOBAL_TOOLS_DIR/volta/bin" "$GLOBAL_TOOLS_DIR/bun/bin" "$GLOBAL_TOOLS_DIR/cargo/bin" "$AGENTS_TOOLS/bin"; do
  if [[ -d "$path" && ! -L "$path" ]]; then
    shared_entry "$path"
  fi
done
# zsh_config is independently versioned. Touch its root, not its contents.
if [[ -d "$ZSH_CONFIG_DIR" && ! -L "$ZSH_CONFIG_DIR" ]]; then
  info "zsh_config checkout root only"
  apply_dir "$ZSH_CONFIG_DIR"
fi
info "Agent parent directory: named-user traverse access, preserve ownership/mode"
run setfacl -m u:rebel:r-x,u:bridge:r-x,u:n8n:r-x -- "$AGENTS_DIR"

PROFILE_PATHS=(
  "$AGENTS_DIR/codex/.codex"
  "$AGENTS_DIR/gemini/.gemini"
  "$AGENTS_DIR/kilo/.kilo"
  "$AGENTS_DIR/minstral/.vibe"
  "$AGENTS_DIR/openchamber"
  "$AGENTS_DIR/opencode"
  "$AGENTS_DIR/qwen/.qwen"
)
if (( SHARE_AGENT_PROFILES )); then
  for root in "${PROFILE_PATHS[@]}"; do
    if [[ ! -d "$root" || -L "$root" ]]; then
      warn "Missing/symlinked profile skipped: $root"
      continue
    fi
    info "Explicit shared profile ACL: $root"
    acl=''
    default_acl=''
    for user in "${TARGET_USERS[@]}"; do
      [[ "$user" == root ]] && continue
      acl+="u:$user:rwX,"
      default_acl+="d:u:$user:rwx,"
    done
    acl="${acl%,}"
    default_acl="${default_acl%,}"
    parent="$(dirname -- "$root")"
    if [[ "$parent" != "$AGENTS_DIR" ]]; then
      # Native profile may be inside a 0700 per-agent parent directory.
      traversal="${acl//:rwX/:r-x}"
      run setfacl -m "$traversal" -- "$parent"
    fi
    # Preserve existing owners and native file modes. ACLs apply to each
    # existing inode without following symlinks; defaults cover new children.
    run setfacl -R -m "$acl" -- "$root"
    if (( DRY_RUN )); then
      info "[DRY RUN] set native profile default ACL on directories under $root"
    else
      find -P "$root" -xdev -type d -exec setfacl -m "$default_acl" -- {} +
    fi
  done
fi

info 'Representative paths:'
for path in "$GLOBAL_TOOLS_DIR" "$GLOBAL_TOOLS_DIR/volta/bin" "$AGENTS_TOOLS" "$AGENTS_DIR" "${PROFILE_PATHS[@]}"; do
  if [[ -e "$path" ]]; then
    info "=== $path ==="
    getfacl -cp -- "$path" | head -n 16 || :
  else
    warn "Absent: $path"
  fi
done
info 'Complete: shared agent ACLs reconciled; no home symlinks, service units or Git metadata modified.'
info "Log: $LOG_FILE"
