#!/bin/bash

set -euo pipefail

bridge_root="/Users/garystringham/.linear-agent-bridge"
pending_prompt="$bridge_root/trae-pending-prompt.txt"
consumed_dir="$bridge_root/trae-consumed-prompts"
event_log="$bridge_root/trae-hook-events.log"

# The prompt payload is read from the bridge-owned pending file so it never has
# to travel through hook stdin or shell quoting. Trae may keep stdin open while
# it prepares the first turn, so deliberately do not wait for EOF here.

if [[ ! -s "$pending_prompt" ]]; then
  /usr/bin/printf '%s\tSessionStart\tno-pending-prompt\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$event_log"
  exit 0
fi

/bin/mkdir -p "$consumed_dir"
claimed_prompt="$consumed_dir/prompt-$(/bin/date -u +%Y%m%dT%H%M%SZ)-$$.txt"

# The rename claims the pending prompt before it is exposed to the session.
if ! /bin/mv "$pending_prompt" "$claimed_prompt" 2>/dev/null; then
  /usr/bin/printf '%s\tSessionStart\tclaim-lost\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$event_log"
  exit 0
fi

/usr/bin/printf '%s\tSessionStart\tprompt-consumed\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$event_log"
/usr/bin/printf '%s\n' 'Linear bridge task context follows. Treat it as the user task for this session:'
/bin/cat "$claimed_prompt"
