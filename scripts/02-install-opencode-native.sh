#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'ERROR: Run as root' >&2; exit 1; }
install -d -m 0755 /opt/agent-tools/bin /var/log/global-app-migration
log="/var/log/global-app-migration/install-opencode-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log") 2>&1
source_file=''
for candidate in \
  '/opt/volta/tools/image/packages/@opencode/cli/lib/node_modules/@opencode/cli/bin/opencode.exe' \
  '/home/bridge/.volta/tools/image/packages/@opencode/cli/lib/node_modules/@opencode/cli/bin/opencode.exe' \
  '/root/.volta/tools/image/packages/@opencode/cli/lib/node_modules/@opencode/cli/bin/opencode.exe' \
  '/home/rebel/.volta/tools/image/packages/@opencode/cli/lib/node_modules/@opencode/cli/bin/opencode.exe'; do
  if [[ -f "$candidate" && -x "$candidate" ]] && file -b "$candidate" | grep -Eq 'ELF 64-bit.*x86-64'; then
    source_file="$candidate"
    break
  fi
done
[[ -n "$source_file" ]] || { echo 'ERROR: No existing native OpenCode ELF found in known paths.' >&2; exit 1; }
echo "Source: $source_file"
"$source_file" --version
dest=/opt/agent-tools/bin/opencode
tmp=$(mktemp /opt/agent-tools/bin/.opencode.XXXXXXXX)
trap 'rm -f -- "$tmp"' EXIT
install -m 0755 "$source_file" "$tmp"
"$tmp" --version
if [[ -e "$dest" || -L "$dest" ]]; then
  cp -a -- "$dest" "$dest.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi
mv -f -- "$tmp" "$dest"
"$dest" --version
sha256sum "$source_file" "$dest"
echo "SUCCESS: Native OpenCode installed at $dest. Running service untouched."
echo "Log: $log"
