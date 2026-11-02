#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE="$(command -v node)"
[[ -x "$NODE" ]] || { echo "node not found" >&2; exit 1; }
LABEL="io.revrebel.linearbridge.github-event-publisher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${NODE}</string><string>${ROOT}/scripts/publish-github-events.mjs</string></array>
<key>WorkingDirectory</key><string>${ROOT}</string>
<key>StartInterval</key><integer>900</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${HOME}/Library/Logs/linearbridge-github-events.log</string>
<key>StandardErrorPath</key><string>${HOME}/Library/Logs/linearbridge-github-events.err.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} (every 15 minutes)"
echo "Logs: ~/Library/Logs/linearbridge-github-events*.log"
