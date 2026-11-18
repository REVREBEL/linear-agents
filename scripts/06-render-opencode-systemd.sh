#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
[[ -x /opt/agent-tools/bin/opencode ]] || { echo 'Install native OpenCode first' >&2; exit 1; }
install -d -m 0755 /opt/agent-tools/systemd
out=/opt/agent-tools/systemd/opencode-shared.service.proposed
cat > "$out" <<'UNIT'
# PROPOSED UNIT. Review User, EnvironmentFile, and service arguments before installation.
# Do not enable this until the existing OpenCode/OpenChamber service is safely cut over.
[Unit]
Description=REVREBEL Shared OpenCode (PROPOSED)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bridge
WorkingDirectory=/home/bridge
Environment=PATH=/opt/agent-tools/bin:/opt/volta/bin:/usr/local/bin:/usr/bin:/bin
Environment=VOLTA_HOME=/opt/volta
# Supply provider credentials, endpoint config, and stable XDG directories using a protected environment file.
# EnvironmentFile=/etc/agent-bridge/opencode.env
ExecStart=/opt/agent-tools/bin/opencode serve --service
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$out"
echo "Wrote $out (NOT installed, enabled or started)."
echo 'Review ExecStart and port/network arguments against existing service before any cutover.'
