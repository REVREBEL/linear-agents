# REVREBEL remaining Ubuntu agent migration scripts

This is the **remaining** work after the successful Node 26 `/opt/volta` rebuild. No earlier Volta rebuild or upgrade scripts are included. Run scripts as root, from any working directory. The directory `/opt/scripts` may be used temporarily for extraction, then removed once migration is finished.

## Order

1. `00-prepare-opt-directories.sh`: Create `/opt/agent-tools/bin`, `/opt/agents/{opencode,gemini,kilo,codex}`, `/opt/bun`, `/opt/uv`, `/opt/venv`. Leaves `/opt/volta` alone. Agent directories start private to root.
2. `01-install-agent-clis.sh`: Install Gemini, Kilo and Linear MCP under Node 26 in `/opt/volta`. If already run, this is safe to rerun to refresh package versions.
3. `02-install-opencode-native.sh`: Locate existing OpenCode ELF using known locations and copy it into `/opt/agent-tools/bin` (does not restart service).
4. `03-install-uv.sh`: Copy a working uv executable to `/opt/agent-tools/bin`. Does not migrate project virtual environments or agent bridge `.venv`.
5. `04-install-bun.sh`: Copy Bun binary from existing root installation into `/opt/bun/bin`.
6. `05-prepare-agent-state.sh`: Prepare ownership groups and directories. **Do not import or merge credentials and sessions until a stable service user is chosen.**
7. `06-render-opencode-systemd.sh`: Write a PROPOSED unit, not installed, enabled or started. Existing OpenCode and OpenChamber processes remain unchanged.
8. `07-audit-old-toolchains.sh`: Report only, no deletions.

## Protected scope

- Do not modify or migrate n8n, `/root/.volta`, or the new Agent Bridge folder and its `.venv`.
- Do not modify running OpenCode, OpenChamber, Agent Bridge, n8n or PM2 services.
- Do not touch the unrelated inactive Stayntouch installation.
- Preserve user-local agent histories and provider auth; don't combine different Unix identities' sessions.

## Usage

```
cd /opt/scripts
bash 00-prepare-opt-directories.sh
bash 01-install-agent-clis.sh
bash 02-install-opencode-native.sh
bash 03-install-uv.sh
bash 04-install-bun.sh
bash 05-prepare-agent-state.sh
bash 06-render-opencode-systemd.sh
bash 07-audit-old-toolchains.sh
```

Execute sequentially; inspect logs if any step exits unsuccessfully. None of these steps performs a service cutover. Service identity, endpoint and environment settings must be reconciled before activating a replacement OpenCode unit.
