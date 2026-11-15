#!/usr/bin/env bash
# Review-first import of /opt/scripts into this repository's scripts/ directory.
# Does not delete, overwrite, stage, commit, or push any file.
set -Eeuo pipefail

usage() {
  printf 'Usage: %s --dry-run|--apply [--source /opt/scripts] [--repo /path/to/linear-agents]\n' "${0##*/}"
}
mode=''
source_dir='/opt/scripts'
repo_dir=''
while (( $# )); do
  case "$1" in
    --dry-run|--apply)
      [[ -z "$mode" ]] || { usage >&2; exit 2; }
      mode="$1"; shift ;;
    --source|--repo)
      (( $# >= 2 )) || { usage >&2; exit 2; }
      if [[ "$1" == --source ]]; then source_dir="$2"; else repo_dir="$2"; fi
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$mode" ]] || { usage >&2; exit 2; }
if [[ -z "$repo_dir" ]]; then
  repo_dir="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
fi
[[ -d "$source_dir" && ! -L "$source_dir" ]] || { echo "Invalid source: $source_dir" >&2; exit 1; }
[[ -d "$repo_dir/.git" || -f "$repo_dir/.git" ]] || { echo "Not a Git checkout: $repo_dir" >&2; exit 1; }
[[ -d "$repo_dir/scripts" ]] || { echo "Expected existing repository scripts/ directory" >&2; exit 1; }
source_dir="$(realpath -e -- "$source_dir")"
repo_dir="$(realpath -e -- "$repo_dir")"
[[ "$source_dir" != "$repo_dir"* && "$repo_dir" != "$source_dir"* ]] || { echo 'Source and repository must be separate' >&2; exit 1; }

echo "Source: $source_dir"
echo "Destination: $repo_dir/scripts"
echo "Mode: $mode"
echo 'Only regular, non-hidden files with non-sensitive filenames are candidates.'
echo 'No tracked files are ever overwritten. Review content and git diff before committing.'

count=0
skipped=0
conflicts=0
while IFS= read -r -d '' file; do
  rel="${file#"$source_dir"/}"
  case "/$rel" in
    */.*|*/.*/ * ) ((skipped+=1)); continue ;;
  esac
  # Exclude obvious sensitive/runtime paths, without claiming to detect secrets in content.
  lower="${rel,,}"
  case "$lower" in
    *credential*|*secret*|*token*|*password*|*auth*|*.env|*.env.*|*.key|*.pem|*.p12|*.pfx|*.sqlite*|*.db|*.log)
      ((skipped+=1)); continue ;;
  esac
  dest="$repo_dir/scripts/$rel"
  if [[ -e "$dest" || -L "$dest" ]]; then
    if cmp -s -- "$file" "$dest"; then
      printf 'UNCHANGED %s\n' "$rel"
    else
      printf 'CONFLICT  %s (existing repository file; not overwritten)\n' "$rel"
      ((conflicts+=1))
    fi
    continue
  fi
  printf '%s %s\n' "${mode#--}" "$rel"
  if [[ "$mode" == --apply ]]; then
    mkdir -p -- "$(dirname "$dest")"
    cp -p -- "$file" "$dest"
  fi
  ((count+=1))
done < <(find "$source_dir" -type f -print0)

printf 'Candidates: %d | Skipped: %d | Conflicts: %d\n' "$count" "$skipped" "$conflicts"
echo 'Inspect every new file for embedded secrets before staging or pushing.'
if (( conflicts > 0 )); then exit 3; fi
