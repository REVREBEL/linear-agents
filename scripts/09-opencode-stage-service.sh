#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
[[ -x /opt/agent-tools/bin/opencode ]] || { echo 'Missing OpenCode binary' >&2; exit 1; }
[[ -d /opt/agents/opencode/.config ]] || { echo 'Run 08 first' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl required' >&2; exit 1; }
install -d -m 0700 /etc/agent-tools
install -d -m 0755 /opt/scripts/generated
ENV_FILE=/etc/agent-tools/opencode.env
if [[ ! -e "$ENV_FILE" ]]; then
  umask 077
  password="$(openssl rand -hex 32)"
  printf 'OPENCODE_PASSWORD=%s\n' "$password" > "$ENV_FILE"
  unset password
  echo 'Created new private password file'
else
  echo 'Preserved existing password file'
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"
UNIT=/opt/scripts/generated/opencode-central.service
cat > "$UNIT" <<'UNITFILE'
[Unit]
Description=REVREBEL OpenCode central API (localhost only)
After=network.target

[Service]
Type=simple
User=bridge
Group=bridge-adm
WorkingDirectory=/opt/agents/opencode
Environment=HOME=/opt/agents/opencode
Environment=XDG_CONFIG_HOME=/opt/agents/opencode/.config
Environment=XDG_DATA_HOME=/opt/agents/opencode/.local/share
Environment=XDG_STATE_HOME=/opt/agents/opencode/.local/state
Environment=XDG_CACHE_HOME=/opt/agents/opencode/.cache
Environment=VOLTA_HOME=/opt/volta
Environment=PATH=/opt/agent-tools/bin:/opt/volta/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/agent-tools/opencode.env
ExecStart=/opt/agent-tools/bin/opencode serve --hostname 127.0.0.1 --port 4096
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
UNITFILE
chmod 0644 "$UNIT"
systemd-analyze verify "$UNIT"
echo "PASS: staged only: $UNIT (service not started)"
