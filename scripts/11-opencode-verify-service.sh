#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root to read secret' >&2; exit 1; }
if ! systemctl is-active --quiet opencode-central.service; then
  journalctl -u opencode-central.service -n 35 --no-pager >&2
  exit 1
fi
ss -ltnp '( sport = :4096 )'
python3 - <<'PY'
from pathlib import Path
import base64, urllib.request, urllib.error, sys
values={}
for line in Path('/etc/agent-tools/opencode.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        k,v=line.split('=',1)
        values[k]=v.strip().strip('"').strip("'")
password=values.get('OPENCODE_PASSWORD')
if not password: sys.exit('Missing OPENCODE_PASSWORD')
token=base64.b64encode(('opencode:'+password).encode()).decode()
req=urllib.request.Request('http://127.0.0.1:4096/api/info',headers={'Authorization':'Basic '+token})
try:
    with urllib.request.urlopen(req,timeout=8) as response:
        print('HTTP:',response.status,'content-type:',response.headers.get('content-type'))
except urllib.error.HTTPError as e:
    sys.exit(f'HTTP check returned {e.code}; inspect OpenCode logs or endpoint')
except Exception as e:
    sys.exit(f'HTTP connection failed: {e}')
PY
echo 'PASS: OpenCode responds locally with password auth'
