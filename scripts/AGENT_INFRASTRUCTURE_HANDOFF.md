# Ubuntu Agent Infrastructure: Drive Layout, Shared-State Model, and Agent Handoff

**Date:** 2026-11-17  
**Host:** `rebel-server` (Ubuntu)  
**Repository:** `REVREBEL/linear-agents`  
**Infrastructure branch:** `infrastructure`, checked out directly at `/opt`  
**Application branch:** `main`, separately checked out for the Agent Bridge application  
**Status:** Architecture established; shared-profile runtime and permissions remain **unresolved**. This is a handoff, **not** a claim that everything works.

## 1. Design intent

The Ubuntu server hosts multiple local AI command-line agents and the Linear Agent Bridge. The intended arrangement centralizes executable/tool installations under `/opt/global-tools`, agent-specific native profiles under `/opt/agents`, and common cross-agent resources under `/opt/agent-tools`.

Four local identities (`root`, `rebel`, `bridge`, `n8n`) use home-directory symlinks to these locations. Symlink **inode ownership** belongs to the local account; it does not grant permissions to the shared target. Profile access is controlled by POSIX ACLs. Centralized profile access is an **intentional goal**, but shared writable session, socket, daemon, and temporary files can conflict across Unix users. Treat that as an open engineering issue, not a solved permission-only problem.

**Boundaries:** Do not rewrite `~/.zshenv`, merge or discard auth/session data, restart services, recursively chmod toolchain packages, or modify unrelated software without a separate decision and verification.

## 2. Two branches, two independent working directories

| Purpose | Git branch | Ubuntu checkout | Scope |
|---|---|---|---|
| Infrastructure, scripts, top-level layout documentation | `infrastructure` | `/opt` | Directly tracks allowed `/opt` paths |
| Linear Agent Bridge application | `main` | Bridge application working tree (historically `/home/bridge/agent-bridge`; check live system) | Agent Bridge source, workers, handlers, orchestration |

These are **not two repositories**. They are two branches of `REVREBEL/linear-agents` with independent checkouts and no implied synchronization. From `/opt`:

```bash
git -C /opt status --short --branch
git -C /opt branch --show-current  # should be infrastructure
git -C /opt pull --ff-only
```

`/opt/zsh_config` is a **separate** repository and must not be treated as part of the `infrastructure` checkout. Confirm current application checkout paths via systemd and `git rev-parse --show-toplevel` rather than assuming historical layout.

## 3. Intended /opt filesystem map

```text
/opt/                                Git checkout: infrastructure
├── .gitignore                       Allowlist; do not track credentials/runtime data
├── README.md                        Optional infrastructure landing page
├── scripts/                         Tracked deployment, permissions and symlink scripts
│   ├── README.md
│   ├── global_permissions.sh        Shared directory ownership + native profile ACLs
│   ├── link-agent-homes.sh          User-home symlink installer
│   └── AGENT_INFRASTRUCTURE_HANDOFF.md   THIS DOCUMENT
├── agents/                          Native agent profile/state, not shared binaries
│   ├── codex/.codex/                Codex home: config, auth, sessions, daemon, tmp
│   ├── gemini/.gemini/              Gemini/Antigravity native profile
│   │   ├── antigravity/
│   │   ├── antigravity-cli/
│   │   ├── antigravity-ide/
│   │   └── antigravity-browser-profile/
│   ├── kilo/.kilo/
│   ├── minstral/.vibe/              Existing spelling 'minstral': preserve as-is
│   ├── openchamber/                 Native application config/state
│   ├── opencode/                    Native application config/state
│   ├── qwen/.qwen/
│   ├── trae/                         Agent-specific files (native mapping unconfirmed)
│   └── registry/                     Registry/material; audit before writing
├── agent-tools/                     Cross-agent integrations, skills, and utilities
│   ├── agents/                       Shared ~/.agents target
│   └── bin/                          Common agent utility entrypoints
├── global-tools/                    Shared installed CLI/runtime toolchain
│   ├── bun/
│   ├── cargo/
│   ├── go/
│   ├── npm/
│   ├── pm2/
│   ├── snap/
│   ├── uv/
│   ├── venv/
│   ├── volta/
│   │   ├── bin/                     Volta shims: node, codex, etc.
│   │   └── tools/image/packages/    Installed npm package images
│   └── yarn/
└── zsh_config/                      Independent repository, not owned by /opt Git
```

This map shows **intended names and known paths**, not a fresh filesystem inventory. Verify all paths exist before touching them. Historical scripts/READMEs may still refer to older `/opt/volta` or `/opt/bun`; the latest planned tool root is `/opt/global-tools`.

### Git tracking policy

The `infrastructure` branch uses a top-level allowlist in `/opt/.gitignore`. It tracks the scripts directory and specifically permitted README/.gitkeep entries in agents/tools, but **does not version native agent session/config/credential directories or installed runtimes**. Do not use `git add -f` to push auth files or runtime state.

## 4. User-home symlink model

`/opt/scripts/link-agent-homes.sh` targets `root`, `rebel`, `bridge`, `n8n`. It uses `getent passwd` for each actual home, not a single `$HOME`. It creates a link only when the destination does not already exist; by default it **preserves existing directories**. `--archive-existing` is explicit and must be reviewed, especially for PM2, Volta and credentials.

| Home entry | Shared target |
|---|---|
| `~/.codex` | `/opt/agents/codex/.codex` |
| `~/.gemini` | `/opt/agents/gemini/.gemini` |
| `~/.kilo` | `/opt/agents/kilo/.kilo` |
| `~/.vibe` | `/opt/agents/minstral/.vibe` |
| `~/.openchamber` | `/opt/agents/openchamber` |
| `~/.opencode` | `/opt/agents/opencode` |
| `~/.qwen` | `/opt/agents/qwen/.qwen` |
| `~/.agents` | `/opt/agent-tools/agents` |
| `~/.bun`, `~/.cargo`, `~/.go`, `~/.npm`, `~/.pm2`, `~/.snap`, `~/.uv`, `~/.venv`, `~/.volta`, `~/.yarn` | Corresponding same-named directory under `/opt/global-tools` |

The link is owned using `chown -h UID:GID` on **the symlink inode**, never by changing all shared target ownership.

**Important:** A previously captured dry run showed conflicts such as existing `/root/.codex`, `/home/rebel/.openchamber`, `.agents`, `.npm`, `.pm2`, `.volta`, and several corresponding `bridge`/`n8n` folders. Do not assume those have been migrated. Audit `readlink -f`, `ls -ld`, `getent passwd`, active services, and backup needs separately.

## 5. Permission model and current script

`/opt/scripts/global_permissions.sh` is the current permissions entrypoint. The 2026-11-17 revision deliberately stopped recursively changing all installed package files after an earlier dry run enumerated approximately **128,445 filesystem entries** and roughly **256,890 proposed chown/chmod operations**, heavily concentrated in Cargo, Volta, Go, and Yarn.

### Shared installation entrypoints

- Manage `/opt/global-tools`, designated tool roots, selected bin dirs, `/opt/agent-tools`, `/opt/scripts`, and only the root of the separate `/opt/zsh_config` checkout.
- Intended directory owner/group: `bridge:bridge-adm`; mode `2775` (setgid). The script currently applies this on the designated directories, **not** recursively to installed package trees.
- Preserve existing package permissions, caches, and runtime metadata. Some existing ACLs include `bridge-usr` and `bridge-adm`; the script does not remove all legacy ACL entries.
- A `--dry-run` shows proposals, and prints **current** `getfacl` results (not simulated post-apply ACLs).

### Native agent profiles

- On `/opt/agents`, use **named-user traverse ACLs** for `rebel`, `bridge`, `n8n`, preserving the directory's owner/mode.
- On nested agent parents (`/opt/agents/codex`, `gemini`, `kilo`, `minstral`, `qwen`), grant named-user `r-x` traversal.
- On configured actual profile roots, named-user `rwX` ACLs are applied recursively to **existing** entries, and default named-user ACLs to directories for **future** entries. `root` retains normal privileged access.
- The **latest script enables native profile ACL reconciliation by default**. `--no-agent-profiles` disables it; the old `--share-agent-profiles` option is still accepted.
- This is the **declared sharing policy**, not a guarantee that every application can safely share its live runtime. In particular, executable helper aliases, SQLite databases, concurrent writes, Unix-domain sockets, locks, and daemon state may need distinct per-user homes/runtime directories.
- Review `setfacl` mask/effective rights after applying. Never make entire agent profiles world-writable or recursively chown secrets to an arbitrary account.

### Running the script

```bash
git -C /opt pull --ff-only
sudo bash -n /opt/scripts/global_permissions.sh
sudo bash /opt/scripts/global_permissions.sh --dry-run
# inspect output and active job status before changing permissions
sudo bash /opt/scripts/global_permissions.sh --apply
```

**Known confirmed status:** The user successfully pulled the latest `infrastructure` commit and ran the new **dry run** at approximately 14:20 Pacific on 2026-11-17. The output showed **targeted entrypoint operations and agent ACL proposals**. It is **NOT confirmed** that `--apply` was run successfully before the later Codex failures. Verify state directly.

**Security caveat for follow-on agent:** The latest `global_permissions.sh` deliberately manages only entrypoint directories under `/opt/global-tools`, and may still need refinement to reconcile actual toolchain write permissions, default ACL inheritance, and per-process state boundaries. Do not assume that setting parent `2775` fixes nested Volta/Cargo access.

## 6. Codex executable and SSH setup

Known CLI facts from actual user commands:

- Interactive shell `PATH` included `/opt/global-tools/volta/bin`; remote SSH non-interactive `PATH` omitted it.
- `/usr/local/bin/codex` was created as a symlink to `/opt/global-tools/volta/bin/codex`, which resolves to `/opt/global-tools/volta/bin/volta-shim`.
- `volta which codex` returned `/opt/global-tools/volta/tools/image/packages/@openai/codex/bin/codex`.
- `ssh rebel-server 'command -v codex; codex --version'` succeeded with `/usr/local/bin/codex`, `codex-cli 0.169.0`.
- `ssh rebel-server 'whoami; command -v node; node --version; codex app-server --help'` ran as `root`, found `/usr/bin/node` v22.22.1, and exited successfully for `app-server --help`.
- **The macOS Codex desktop SSH connection continued displaying “Codex CLI is not installed on this remote machine” despite these checks.** A `--help` check is not a live app-server handshake. Do not confuse this unresolved desktop integration failure with CLI absence.

`/usr/local/bin/codex` symlink mode `lrwxrwxrwx` is normal; `namei -l` showed traversal/executable access through `volta-shim`. Avoid further chmod of those paths without evidence.

## 7. Active failures observed as rebel

### Prior error (configuration traversal)

```text
Error: exec-server protocol error:
failed to read environment config /home/rebel/.codex/environments.toml:
Permission denied (os error 13)
```

The `rebel` account's `~/.codex` resolves to `/opt/agents/codex/.codex`. A `namei -l` run as `rebel` showed `/opt/agents/codex` as `drwx------` owned by numeric **UID 1004**, group **n8n**, preventing directory traversal. Earlier output showed `/opt/agents/codex/.codex/tmp/arg0` mode `700`, also owned by numeric UID 1004 and group n8n. **Do not equate UID 1004 with the current `n8n` account without checking `getent passwd 1004`**: an earlier snapshot showed the configured n8n account had UID 111.

### Current failure (after shared ACL revision was dry-run)

```text
WARNING: proceeding, even though we could not create PATH aliases:
Operation not permitted (os error 1)
Error: app server did not become ready on
/home/rebel/.codex/app-server-control/app-server-control.sock

Daemon used app-server:
  path: /home/rebel/.codex/packages/app-server-daemon/current/bin/codex
  version: 0.169.0

Managed app-server stderr:
  WARNING: proceeding, even though we could not create PATH aliases:
  Operation not permitted (os error 1)
  Error: Operation not permitted (os error 1):
  failed to connect to .../app-server-control.sock:
  Connection refused (os error 111)
```

Even `codex --no-daemon` failed with `Operation not permitted (os error 1)` and the PATH aliases warning. Thus the problem is **not proven to be exclusively the daemon/socket**.

A previous warning variant was `File exists (os error 17)`. The exact helper-file conflict remains unknown.

### Hypotheses to test, not established facts

- Shared profile's existing socket, temp aliases or files owned by another Unix identity.
- POSIX ACL effective masks, filesystems, symlink permissions, sticky-bit/protected-file behavior, active daemon processes or stale sockets.
- App-server binary's runtime requirements / startup operations.
- Concurrent agents sharing one daemon control socket path and writable home.
- Need for per-user daemon/temporary state while retaining centrally installed CLI and shared skills/config (investigate supported Codex capabilities before redesigning).

**Do not delete the `app-server-control` socket, `tmp/arg0`, or authentication files based on hypotheses alone.**

## 8. Other issue verified and fixed: /tmp

1Password CLI previously failed:

```text
couldn't start daemon: cannot create directory "/tmp/com.agilebits.op.1000":
permission denied
```

`/tmp` was discovered as `755 root:root` rather than standard `1777 root:root`. User ran `sudo chmod 1777 /tmp` and confirmed **that fixed the 1Password CLI problem**. If it reappears, investigate who changed `/tmp` permissions; the intentional `/opt` scripts are not supposed to manage `/tmp`. `1Password Connect` server and `op` CLI are different processes/services; do not disrupt Connect while debugging CLI issues.

## 9. Operational constraints and no-touch zones

- **Preserve credentials, provider authentication, prior conversations, histories, sessions, and plugin/skill content.** No indiscriminate `chown -R`, `chmod -R 777`, `rm -rf`, or wholesale migrations.
- Keep each per-user `~/.zshenv` locally owned and untouched by these scripts. Zsh login/interactive/remote noninteractive environments differ; do not claim an SSH CLI lookup failure is automatically caused by zshenv.
- The `bridge` systemd service, PM2/LiteLLM, OpenCode/OpenChamber, n8n and other active services must not be restarted or repointed without auditing the running processes.
- `~/.pm2` sharing is especially risky: multiple Unix identities may contend for the same PM2 daemon/socket/log state. Prefer an explicitly managed service identity if maintaining a single PM2 control plane.
- Changes to `/opt/zsh_config` require awareness of its separate Git checkout.
- Historical application paths and runtime versions may differ; inventory live process, Git, and service state before changes.
- `/opt/agents/gemini/.gemini` contains **Antigravity** CLI/browser/IDE state. `agy` is the expected Antigravity CLI; do not replace it with unverified legacy Gemini CLI behavior.

## 10. Safe takeover checklist

**Inventory, without mutation:**

```bash
hostname; id; getent passwd root rebel bridge n8n; getent passwd 1004 || true
git -C /opt status --short --branch
find /opt/agents -maxdepth 3 -type d -printf '%m %u:%g %p\n' | head -n 100
namei -l /home/rebel/.codex/environments.toml
namei -l /home/rebel/.codex/app-server-control/app-server-control.sock
getfacl -p /opt/agents /opt/agents/codex /opt/agents/codex/.codex
getfacl -p /opt/agents/codex/.codex/tmp/arg0
ls -la /opt/agents/codex/.codex/app-server-control
ps -eo user,pid,args | grep -E '[c]odex|[p]m2|[o]pencode|[o]penchamber'
stat -c '%a %U:%G %n' /tmp
```

**Check execution as target account; avoid printing secrets:**

```bash
sudo -u rebel test -r /home/rebel/.codex/environments.toml && echo 'config readable'
sudo -u rebel test -w /home/rebel/.codex/tmp/arg0 && echo 'arg0 writable'
sudo -u rebel /usr/local/bin/codex --version
sudo -u rebel /usr/local/bin/codex --no-daemon
```

`--no-daemon` can start an interactive process; use intentionally and record the result. Run `global_permissions.sh --dry-run` before deciding on `--apply`, and verify the result on the actual live filesystem afterward.

**Next engineering goals:**

1. Establish actual post-apply ACL state and resolve `rebel` Codex startup without deleting sessions.
2. Determine why path aliases report `EPERM`, including concrete failed syscalls (e.g. bounded `strace -f -e trace=%file,process,network` with careful log handling because paths can be sensitive).
3. Investigate safe ownership/isolation strategy for app-server socket, temp helpers, per-user daemon state and potentially PM2, while preserving shared skills/config and centrally installed binaries.
4. Verify desktop SSH detection against actual app-server startup, not only `--help`.
5. Audit old vs new `/opt` paths and ensure installation and ACL scripts are idempotent, narrow, and cannot weaken secrets.
6. Update docs/scripts on **`infrastructure`**, test (syntax and simulated fixture where feasible), and provide a reviewable PR or commit. Do not silently modify the independent `main` or `zsh_config` worktree.

## 11. Sources of truth on server

- `/opt/scripts/global_permissions.sh`: current desired ACL and shared entrypoint model.
- `/opt/scripts/link-agent-homes.sh`: exact symlink list and safe preserve/archive behavior.
- `/opt/scripts/README.md`: migration history; **earlier steps and paths may be legacy**.
- `/opt/.gitignore`: tracked/untracked policy.
- `systemctl cat agent-bridge`, `systemctl status agent-bridge`, `pm2 list` under the **correct service account**, `getent`, `namei`, `getfacl`, and `ps`: confirm reality, do not infer from the intended diagram.

**Handoff principle:** Shared **installations and references** are straightforward. Shared **live process state** is not. Diagnose Codex's concrete failing operation before changing the global permission policy again.
