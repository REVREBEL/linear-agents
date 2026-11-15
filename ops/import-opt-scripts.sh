#!/usr/bin/env bash
# Explicit, review-first import from /opt/scripts to repository scripts/.
# Never replaces destination files, commits, pushes, or deletes anything.
set -Eeuo pipefail

usage() {
  echo "Usage: $0 --dry-run|--apply [--source /opt/scripts] [--repo /path/to/linear-agents]" >&2
}
mode='' source_dir='/opt/scripts' repo_dir=''
while (( $# )); do
  case "$1" in
    --dry-run|--apply) [[ -z "$mode" ]] || { usage; exit 2; }; mode="$1"; shift ;;
    --source|--repo)
      (( $# >= 2 )) || { usage; exit 2; }
      if [[ "$1" == --source ]]; then source_dir="$2"; else repo_dir="$2"; fi
      shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
[[ -n "$mode" ]] || { usage; exit 2; }
if [[ -z "$repo_dir" ]]; then
  repo_dir="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
fi
[[ -d "$source_dir" && ! -L "$source_dir" ]] || { echo 'Invalid source directory' >&2; exit 1; }
[[ -d "$repo_dir" && -d "$repo_dir/.git" || -f "$repo_dir/.git" ]] || { echo 'Invalid Git checkout' >&2; exit 1; }
source_dir="$(realpath -e -- "$source_dir")"
repo_dir="$(realpath -e -- "$repo_dir")"
[[ "$source_dir" != / && "$source_dir" != "$repo_dir" ]] || { echo 'Overlapping source and checkout' >&2; exit 1; }
case "$repo_dir/" in "$source_dir/"*) echo 'Repository is inside source' >&2; exit 1;; esac
case "$source_dir/" in "$repo_dir/"*) echo 'Source is inside repository' >&2; exit 1;; esac

dest_root="$repo_dir/scripts"
[[ -d "$dest_root" && ! -L "$dest_root" ]] || { echo 'Destination scripts/ must be a real directory' >&2; exit 1; }
[[ "$(realpath -e -- "$dest_root")" == "$dest_root" ]] || { echo 'Destination resolves outside checkout' >&2; exit 1; }

# Refuse symlinks anywhere under the destination, including intermediate components.
if [[ -n "$(find -P "$dest_root" -type l -print -quit)" ]]; then
  echo 'Destination contains symlinks; refusing import' >&2
  exit 1
fi

manifest="$(mktemp)"
snapshot="$(mktemp)"
trap 'rm -f -- "$manifest" "$snapshot"' EXIT
# Fail before importing if the source cannot be enumerated completely.
find -P "$source_dir" -type f -print0 > "$manifest"

# Capture input size + nanosecond mtime and compare again after import.
while IFS= read -r -d '' file; do
  stat -c '%n %s %y' -- "$file"
done < "$manifest" > "$snapshot"

count=0 skipped=0 conflicts=0 ignored=0
while IFS= read -r -d '' file; do
  rel="${file#"$source_dir"/}"
  case "/$rel" in */.*) ((skipped+=1)); continue;; esac
  lower="${rel,,}"
  case "$lower" in
    *credential*|*secret*|*token*|*password*|*auth*|*.env|*.env.*|*.key|*.pem|*.p12|*.pfx|*.sqlite*|*.db|*.log)
      ((skipped+=1)); continue ;;
  esac
  repo_path="scripts/$rel"
  dest="$repo_dir/$repo_path"

  if git -C "$repo_dir" check-ignore -q -- "$repo_path"; then
    echo "IGNORED  $repo_path"; ((ignored+=1)); continue
  fi
  if git -C "$repo_dir" ls-files --error-unmatch -- "$repo_path" >/dev/null 2>&1; then
    echo "TRACKED  $repo_path (not overwritten)"; ((conflicts+=1)); continue
  fi
  if [[ -e "$dest" || -L "$dest" ]]; then
    if cmp -s -- "$file" "$dest"; then
      echo "EXISTS   $repo_path"
    else
      echo "CONFLICT $repo_path"; ((conflicts+=1))
    fi
    continue
  fi

  echo "${mode#--}    $repo_path"
  if [[ "$mode" == --apply ]]; then
    parent="$(dirname -- "$dest")"
    mkdir -p -- "$parent"
    resolved="$(realpath -e -- "$parent")"
    case "$resolved/" in "$dest_root/"*) ;; *)
      echo "Unsafe destination parent: $parent" >&2; exit 1 ;;
    esac
    # Verify no intermediate symlink after mkdir. Reject even in-tree symlinks.
    relparent="${parent#"$dest_root"}"
    current="$dest_root"
    IFS='/' read -r -a components <<< "${relparent#/}"
    for component in "${components[@]}"; do
      [[ -n "$component" ]] || continue
      current="$current/$component"
      [[ ! -L "$current" ]] || { echo "Symlinked parent: $current" >&2; exit 1; }
    done
    temp="$(mktemp "$parent/.opt-import.XXXXXXXX")"
    if ! cp -p -- "$file" "$temp"; then rm -f -- "$temp"; exit 1; fi
    # Hard link creation is atomic and fails if the target exists. No clobber.
    if ! ln -- "$temp" "$dest"; then
      rm -f -- "$temp"
      echo "CONCURRENT CONFLICT $repo_path" >&2
      exit 1
    fi
    rm -f -- "$temp"
  fi
  ((count+=1))
done < "$manifest"

after="$(mktemp)"
trap 'rm -f -- "$manifest" "$snapshot" "$after"' EXIT
while IFS= read -r -d '' file; do
  stat -c '%n %s %y' -- "$file"
done < "$manifest" > "$after"
if ! cmp -s -- "$snapshot" "$after"; then
  echo 'Source files changed during import; review results before using them' >&2
  exit 1
fi
echo "New candidates: $count | Skipped: $skipped | Ignored: $ignored | Existing/tracked conflicts: $conflicts"
echo 'Review every imported file for secrets before staging or committing.'
(( conflicts == 0 && ignored == 0 ))
