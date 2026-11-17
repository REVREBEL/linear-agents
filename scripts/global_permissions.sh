#!/usr/bin/env bash
# REVREBEL /opt shared ownership and permission reconciliation.
# Shared tools are bridge:bridge-adm; all users may read/traverse/execute.
# Native agent state is excluded unless explicitly opted in.
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
SHARE_AGENT_PROFILES=0
SKIP_NAMES=(.git config pm2 npm .pm2 .npm)

usage() {
  cat <<'HELP'
Usage: sudo bash global_permissions.sh --dry-run [--share-agent-profiles] [--log FILE]
       sudo bash global_permissions.sh --apply [--share-agent-profiles] [--log FILE]
       sudo bash global_permissions.sh --sync-users-only

--dry-run             Show changes without applying permissions.
--apply               Reconcile shared install/script ownership and modes.
--share-agent-profiles Explicitly grant root/rebel/bridge/n8n write access
                       to existing agent profile trees. Use only after
                       reviewing/stopping active agent sessions.
--sync-users-only     Legacy timer compatibility; no-op. New account group
                       enrollment is unnecessary for universal read/execute.
--log FILE            Log output to FILE.

Shared-tree operations skip .git, config, pm2, npm, .pm2 and .npm
subdirectories. Does not change symlinks, home files, or service units.
HELP
}
while (( $# )); do
  case "$1" in
    --dry-run|--apply|--sync-users-only)
      [[ -z "$MODE" ]] || { echo 'Choose exactly one mode' >&2; exit 2; }
      MODE="$1"; shift ;;
    --share-agent-profiles) SHARE_AGENT_PROFILES=1; shift ;;
    --log)
      (( $# >= 2 )) || { echo '--log requires an argument' >&2; exit 2; }
      LOG_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { usage >&2; exit 2; }
if [[ "$MODE" == --sync-users-only ]] && (( SHARE_AGENT_PROFILES )); then
  echo '--share-agent-profiles cannot combine with --sync-users-only' >&2
  exit 2
fi
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
apply_file() {
  local path="$1" mode
  mode="$(stat -c %A -- "$path")"
  run chown -- "$OWNER:$ADMIN_GROUP" "$path"
  if [[ "$mode" == *x* || "$mode" == *s* || "$mode" == *t* ]]; then
    run chmod -- 775 "$path"
  else
    run chmod -- 664 "$path"
  fi
}
apply_shared_tree() {
  local root="$1" name path
  assert_shared_root "$root"
  info "Shared tree: $root"
  local -a prune=()
  for name in "${SKIP_NAMES[@]}"; do prune+=( -name "$name" -o ); done
  unset 'prune[${#prune[@]}-1]'
  # No symlinks, separate mounts, runtime state, or .git metadata traversed.
  while IFS= read -r -d '' path; do
    if [[ -d "$path" && ! -L "$path" ]]; then
      apply_dir "$path"
    elif [[ -f "$path" && ! -L "$path" ]]; then
      apply_file "$path"
    fi
  done < <(find -P "$root" -xdev \( -type d \( "${prune[@]}" \) \) -prune -o \( -type d -o -type f \) -print0)
}
assert_shared_root "$AGENTS_DIR"
for root in "$GLOBAL_TOOLS_DIR" "$AGENTS_TOOLS" "$SCRIPTS_DIR"; do
  apply_shared_tree "$root"
done
# zsh_config is independently versioned. Touch its root, not its contents.
if [[ -d "$ZSH_CONFIG_DIR" && ! -L "$ZSH_CONFIG_DIR" ]]; then
  info "zsh_config checkout root only"
  apply_dir "$ZSH_CONFIG_DIR"
fi
info "Agent parent directory only: $AGENTS_DIR"
apply_dir "$AGENTS_DIR"

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
    # Preserve existing owners; do not follow symlinks.
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
info 'Complete: no home symlinks, services or Git metadata modified.'
info "Log: $LOG_FILE"
