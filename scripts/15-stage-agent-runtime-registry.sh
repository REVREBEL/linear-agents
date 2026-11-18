#!/usr/bin/env bash
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Run as root' >&2; exit 1; }
install -d -m 0755 /opt/agents/registry
TARGET=/opt/agents/registry/agent-runtimes.json
if [[ -e "$TARGET" ]]; then
  echo "Existing registry at $TARGET; refusing overwrite" >&2
  exit 1
fi
# Pure inventory/dispatch contract; no API keys, secrets, model claims or live Bridge edits.
python3 - "$TARGET" <<'PYJSON'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); tmp=p.with_suffix('.json.tmp')
data={
 "schemaVersion":1,
 "status":"staged-not-integrated",
 "launcher":"/opt/agent-tools/bin/agent-exec",
 "defaultNodeHome":"/opt/volta",
 "agentIdentity":"bridge",
 "agents":{
   "opencode":{"command":"/opt/agent-tools/bin/opencode","home":"/opt/agents/opencode","kind":"native","service":"opencode-central.service","invocation":"requires-adapter","enabledForDispatch":False},
   "gemini":{"command":"/opt/volta/bin/gemini","home":"/opt/agents/gemini","kind":"volta","invocation":"requires-adapter","enabledForDispatch":False},
   "kilo":{"command":"/opt/volta/bin/kilo","home":"/opt/agents/kilo","kind":"volta","invocation":"requires-adapter","enabledForDispatch":False},
   "codex":{"command":None,"home":"/opt/agents/codex","kind":"not-installed","invocation":"requires-adapter","enabledForDispatch":False}
 }
}
with tmp.open('w') as f: json.dump(data,f,indent=2);f.write('\n')
tmp.chmod(0o644);tmp.replace(p)
PYJSON
python3 -m json.tool "$TARGET" >/dev/null
echo "Staged dispatch inventory: $TARGET"
echo 'No Bridge code/manifest/service changed; all dispatch entries disabled.'
