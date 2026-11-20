# ABR-96 — Ubuntu sandboxed executor: implementation and release gates

**Status:** Source-only implementation in a separate Agent Bridge worktree. The OS-level executor API is exercised in an isolated Linux Bubblewrap sandbox; **it is not connected to any production MCP `tools/call` endpoint, and no service is started.** ABR-97 handles workstation registration and ABR-98 handles tool discovery/profile exposure. No changes to `agent-bridge.service`, the authoritative `/jobs` ledger, memory, Linear, GitHub, Cloudflare or Synology routing are in this issue.

## Implemented source boundaries

| File | Responsibility and limits |
| --- | --- |
| `bridge/agent/mcp-host-agent/execution-authority.mjs` | Private unforgeable in-process capability, minted **only** after an upstream trusted identity is verified; server-owned client, user, session, device, workspace, tool and write grants, short expiry and revocation. Tool argument identities, environment variables and job text never create authority |
| `bridge/agent/mcp-host-agent/sandbox-runner.mjs` | Linux OS sandbox via required `/usr/bin/bwrap` **unshared user, PID, network, IPC, UTS namespaces**; no unsandboxed fallback. `prlimit` caps CPU, virtual memory, file growth and file descriptors; detached process groups and Bubblewrap parent-death teardown. Mounts only trusted system binaries/libs plus one operator-approved workspace, opened and pinned by directory FD using `--ro-bind-fd` or specifically authorized `--bind-fd`; `/home`, `/root`, network and host `/proc` remain inaccessible |
| `bridge/agent/mcp-host-agent/async-jobs.mjs` | Isolated SQLite outcome journal, atomic unique `(owner,idempotencyKey)`, durable terminal result, ownership on every query/cancellation, queued/running/cancelled/timed_out/failed/completed/interrupted states, bounded per-principal fair queue, `run_command`, `spawn_job`, `wait_jobs`, `get_job`, `list_jobs`, `cancel_job`, `run_parallel` with concurrency/poll/queue bounds; failure/restart never replays side effects |
| `bridge/agent/mcp-host-agent/terminal-sessions.mjs` | Current-process stable interactive REPL handles, writeable stdin, bounded stdout/stderr/cursor pagination, prompt-ready detection, session listing, scoped `force_terminate` and `kill_process`. Handles are not automatically resumed following a host crash |
| `bridge/agent/mcp-host-agent/execution-service.mjs` | Composes trusted authority, runner, journal and terminal; **not imported by ABR-94/95 production relay or running Bridge** |
| `scripts/mcp-executor-probe.mjs` | Side-effect-free per-user Bubblewrap readiness check, `--strict` nonzero failure. The test-only root override is explicit and the default executor refuses UID 0 |

### Technical constraints

- Commands are **structured** `{workspaceId, program, args, cwd, write}`. There is no host shell interpolation; the allowed executables are `python3`, `git`, and `bash`, but a shell executes only *inside* the sandbox. Arbitrary program path and environment override are rejected. Workspace must be a real subtree of configured `PROJECTS_ROOT`; cwd and workspace inode/device are checked before a **pinned-FD mount** to eliminate the validation-to-bind path-replacement race.
- Output is bounded to 128 KiB **per stream** and `prlimit` sets a 16-MiB maximum output-file size within the sandbox. The 512-KiB nested WebSocket frame bound from ABR-94 applies to its existing read-only relay only, not to the new direct executor API. Known operator secret fixtures, common Bearer tokens, `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` env-text patterns and 1Password URI text are redacted before any journal/API response. **This is not comprehensive DLP**; don't place real unreviewed credentials in workspace test fixtures.
- The journal lives outside the sandbox in a 0700, OS-user-owned path with a single-writer lease and SQLite WAL+FULL durability. The journal defaults to **2,000 immutable job records** (configurable with an explicit upper bound); when full it refuses new jobs instead of deleting idempotency keys and risking a replayed write. Retention needs a separately reviewed tombstone/archive strategy. Its job IDs are **not** `jobs/persistence/job-store.mjs` job keys; no host output authorizes `submit_work`, reviewer notification or memU promotion.
- CLI sessions support `>>> ` and other common prompt markers with bounded polling. They are current-agent-process handles, not durable resumable PTYs; a restarted host labels journaled background work interrupted and requires an explicit new interaction rather than silently resuming it.
- The limit/fair-queue contracts are checked before processing; on shutdown, the host terminates process groups and closes owned journal handles. `bwrap --die-with-parent` and a future unit's `KillMode=control-group` provide redundant orphan cleanup.

## Verified environmental blocker — Ubuntu service identity

**Reproduced on `rebel-server.revrebel.io`:**

```text
Service UID: 994 (bridge)
/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 1
runuser -u bridge -- node scripts/mcp-executor-probe.mjs --strict
=> BLOCKED_BY_OS_NAMESPACE_POLICY (exit 2)
=> bwrap: Creating new namespace failed: Permission denied
```

A separate root-run *test-only* sandbox fixture succeeds (unshared PID/network/filesystem). **That does not satisfy production acceptance for the `bridge` OS principal.** The production service must NOT elevate to root or bypass Bubblewrap. A system administrator must explicitly approve a narrow AppArmor/user-namespace policy permitting this particular host-agent identity/Bubblewrap binary, with no global AppArmor restriction disablement; its exact profile must be tested **as `bridge`**. ABR-96 cannot honestly be marked fully operational until that gate succeeds.

The [candidate unit](../../../scripts/linux/systemd/desktopcommander-mcp-host-agent.service.example) is deliberately **non-startable**: optional approval-marker condition, `User=bridge`, `ExecStartPre` strict probe executed through a service-pinned Volta PATH, and `ExecStart=/usr/bin/false`. ABR-97 must supply/review a paired host-agent entrypoint, actual runtime and AppArmor permissions before replacing that sentinel. It is source-only; no service unit is installed or enabled.

## Independent acceptance and rollout checklist

1. Run `node scripts/mcp-executor-probe.mjs --strict` under the **actual intended service user** and insist on exit 0. In the present host configuration this correctly fails as `bridge`.
2. Run `node --test scripts/test-mcp-executor.mjs` as that same `bridge` user (with approved userns/AppArmor profile). Do not accept skipped runtime tests as success.
3. Confirm audited sandbox behavior: no host file/network access; no host environment leakage; expected command stdout/stderr/exit codes; read-only project defaults; explicit scoped project writes; no symlink/path traversal; nonblocking stdin; guaranteed bounded outputs; no orphan subprocess following timeout/cancel.
4. Verify concurrent clients and delayed retries: unique session/client/device/host workspace scopes; same-idempotency-key calls return one job ID and never repeat; a different fingerprint for that key fails; wrong principal cannot list, read or cancel another principal's job; fair scheduling; cancel queued/running; crash/restart marks running/queued interrupted.
5. Compare terminal behavior with the existing connected Desktop Commander: process ID stable within session, interactive `python3 -i -q` input/prompt, stdout/stderr pagination, forced vs graceful process termination, and correct session-list errors. Full 30-tool parity remains ABR-98/100.
6. Validate `systemd-analyze verify` of candidate only. Future approved rollout requires a unique systemd service name and user, protected journal path, AppArmor policy, verified paired agent, rollback and **no** modification of existing `agent-bridge.service`.
7. Run `npm run mcp:executor:test`, `npm run mcp:foundation:test`, `npm run mcp:oauth:test`, `npm run bridge:test`, `npm run test:reliability`, and nearest-owner README/blueprint validators. An isolated root/elevated CI run proves only sandbox implementation mechanics, **not** the service-user prerequisite.

## Operational rollback

If a future explicitly approved canary fails, stop **only** the new MCP host service, revoke paired device/OAuth grants, kill its cgroup, and rollback that unit/config. Do not touch `agent-bridge.service`, existing Worker/OAuth jobs, review inbox, Linear issues or PostgreSQL memory. Failed/old background operations stay interrupted and require fresh authorized instructions to retry; never replay a write based on recovered job text.

**Milestone dependency:** ABR-97 device enrollment and macOS routing, ABR-98 MCP tool-profile exposure and full connected-tool parity, ABR-99 trusted Bridge handoffs, ABR-100 production/dual-host acceptance remain separate.
