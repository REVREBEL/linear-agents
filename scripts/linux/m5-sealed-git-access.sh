#!/usr/bin/env bash
# Narrowly grant the bridge service read-only Git index access in a root-owned sealed release.
# Execute only from the reviewed, root-owned installed release; never from a writable agent worktree.
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == "--check" || "$mode" == "--apply" ]] || exit 2
ROOT=/var/lib/bridge-runtime
INDEX="$ROOT/.git/index"
[[ "$(id -u)" == 0 ]] || { echo 'root operator required' >&2; exit 1; }
for path in / /var /var/lib "$ROOT" "$ROOT/.git"; do
  [[ -d "$path" && ! -L "$path" && "$(stat -c %u "$path")" == 0 ]] || exit 1
  [[ "$(( 8#$(stat -c %a "$path") & 0022 ))" == 0 ]] || exit 1
done
[[ -f "$INDEX" && ! -L "$INDEX" && "$(stat -c %u "$INDEX")" == 0 ]] || exit 1
[[ "$(stat -c %a "$INDEX")" == 600 || "$(stat -c %a "$INDEX")" == 640 ]] || {
  # With a named ACL, stat reflects the effective ACL mask.
  echo 'sealed index permissions are not constrained' >&2; exit 1;
}
if [[ "$mode" == "--apply" ]]; then
  setfacl -m u:bridge:r-- -- "$INDEX"
fi
runuser -u bridge -- env -i HOME=/home/bridge PATH=/usr/bin:/bin GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c safe.directory="$ROOT" -C "$ROOT" rev-parse --verify HEAD >/dev/null
runuser -u bridge -- env -i HOME=/home/bridge PATH=/usr/bin:/bin GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain --untracked-files=no |
  { read -r result && { echo 'sealed release is dirty' >&2; exit 1; } || true; }
echo 'M5_SEALED_GIT_ACCESS=PASS'
