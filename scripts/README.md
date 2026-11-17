# REVREBEL remaining Ubuntu agent migration scripts

> **Agent takeover / current architecture:** Read [AGENT_INFRASTRUCTURE_HANDOFF.md](./AGENT_INFRASTRUCTURE_HANDOFF.md) first. It documents the current `/opt` layout, shared-user permissions, legacy migration paths, observed Codex failures, and safe diagnostic checklist. The historical migration steps below predate the new `/opt/global-tools` arrangement and must not be run blindly.


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


## Shared agent and tool home symlinks

`link-agent-homes.sh` configures dot-directory links in the existing home folders of
`root`, `rebel`, `bridge`, and `n8n`. Edit the variables near the top of the
script to change users or the shared installation roots.

- Agent links: `.codex`, `.gemini`, `.kilo`, `.vibe`, `.openchamber`,
  `.opencode`, and `.qwen` to their corresponding folders under `/opt/agents`.
  The `.gemini` link includes the native Antigravity CLI subfolders under that profile.
- Shared agent resources: `.agents` to `/opt/agent-tools/agents`.
- Shared tools: `.bun`, `.cargo`, `.go`, `.npm`, `.pm2`, `.snap`, `.uv`,
  `.venv`, `.volta`, and `.yarn` to the matching directories under
  `/opt/global-tools`. The `.cargo` link intentionally points to Cargo,
  not Bun.

```bash
sudo bash /opt/scripts/link-agent-homes.sh --dry-run
sudo bash /opt/scripts/link-agent-homes.sh
# Only after stopping dependent applications and reviewing existing data:
sudo bash /opt/scripts/link-agent-homes.sh --archive-existing
```

The script **does not replace or merge any existing user-local directory by default**.
Use `--archive-existing` only after checking whether affected services, especially
PM2 and agent CLIs, still use those directories. That option renames each existing
entry to `NAME_archived_N` before creating its symlink. Every created link is
owned by the respective local user and primary group, using `chown -h`, **without
altering the shared target's ownership or permissions**. Existing correct links
are left in place and their symlink ownership is reconciled.

The script skips missing source directories rather than fabricating an empty
profile. It does not configure CLIs, start/stop services, change group memberships,
modify `~/.zshenv`, or migrate credentials/sessions. Sharing a symlink does
**not** grant read/write access to the target: its ownership and ACLs must be
managed separately. A shared PM2 home means a shared daemon/control context,
not independent per-user PM2 instances.

`HOME_ROOT=$HOME` is recorded as context; each target user's home comes from
`getent passwd`, so running the script as root will not redirect all links
into root's home.


## Global permission reconciliation

`global_permissions.sh` reconciles shared Ubuntu access without modifying
installed dependency files. For tools and scripts it sets `bridge:bridge-adm`
ownership and `2775` mode **only on designated entrypoint directories**:
`/opt/global-tools`, its known tool roots, selected `bin` directories,
`/opt/agent-tools`, `/opt/scripts`, and the `/opt/zsh_config` checkout root.
It does not recurse into Cargo's registry, Volta's package images, Go modules,
Yarn caches, PM2, Git repositories or other package contents.

**Shared native profiles are enabled by default.** The script grants named-user
traverse ACLs on `/opt/agents` and the per-agent parent directories, and
read/write ACLs for `rebel`, `bridge`, and `n8n` on existing native agent
profile trees. Directory default ACLs allow new state to inherit access.
Root retains its usual root privileges. This fixes shared profile access to
`environments.toml` and `tmp/arg0`, without recursively changing ownership
or opening profile data to all local users.

```bash
git -C /opt pull --ff-only
sudo bash /opt/scripts/global_permissions.sh --dry-run
sudo bash /opt/scripts/global_permissions.sh --apply
```

For an entrypoint-only operation that **does not touch agent profiles**:

```bash
sudo bash /opt/scripts/global_permissions.sh --dry-run --no-agent-profiles
sudo bash /opt/scripts/global_permissions.sh --apply --no-agent-profiles
```

Native profiles may contain tokens, authentication state, session logs and
temporary helper files. Granting these users access is an intentional part of
the shared-profile architecture. ACLs do not eliminate application-level
concurrency collisions. Pause active agent jobs before permission
reconciliation where practical. Avoid sharing these native profiles with
untrusted accounts.

The older `--share-agent-profiles` flag remains accepted for compatibility.
The old `--sync-users-only` timer invocation remains a harmless no-op and
should be removed from systemd separately once audited. The script never
modifies home symlinks, `~/.zshenv`, services or unrelated paths.
