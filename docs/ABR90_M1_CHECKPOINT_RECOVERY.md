# ABR-90 M1 — checkpoint recovery integration and source disposition

This is the **first source milestone** of ABR-90, not the whole memory
integration. Work is isolated from the running Ubuntu service. The authoritative
execution record remains `jobs/persistence/job-store.mjs`; checkpoints are
lower-trust context, never instructions or permissions to execute.

## Candidate archive vs. canonical source

Source reviewed: `Memory Integration.zip` attached to Linear ABR-90.
The two copies of `local-checkpoint-recovery-handler.ts` in that archive are
identical. No archive code was pasted into the repository without adapting its
contracts to the current source.

| Archive candidate | Disposition | Canonical home / reason |
| --- | --- | --- |
| `local-checkpoint-recovery-handler.ts` (both copies) | **Adapt** | `memory/active-task-memory.mjs` already owns atomic writes, lock, revision CAS, last-20 events and redaction; use one bounded/scoped recovery rendering helper instead of a second checkpoint store. |
| `linear-compaction-plugin.ts` | **Defer pending runtime API verification** | Existing `memory/opencode-session-checkpoint.mjs` owns provider progress. Validate the installed OpenCode 1.19.5 hook contract and token accounting before enabling pre-compaction writes or injections; no unverified hook registration. |
| `submission-coordinator.ts` | **Adapt in later milestone (ABR-17)** | `bridge/orchestration/` is canonical. The archive has placeholder GitHub/Linear/Worker implementations and synthetic successful PR IDs/SHAs; never ship those defaults or let callers assert issue identity. |
| `submit-work`, `Submit Work CLI.md` | **Rewrite after authenticated coordinator** | CLI is a convenience client, not authorization. Replace unsafe shell-interpolated response parsing and require a bridge-issued bound job/session identity. |
| `001_init_agent_memory_pg18.sql` | **Do not execute** | Existing `memory/migrations/001_agent_checkpoints.sql` already defines four-dimensional checkpoint keys. Proposed archive SQL assumes PG18 on port 5432, contrary to the last documented host state (5433). Reconcile against live schema in a later **additive** migration. |
| `PostgreSQL Agent Memory.md` | **Reference only** | `memory/POSTGRES_CHECKPOINT_ADAPTER.md` describes an unconnected, experimental driver-injected adapter; source presence is not production activation. |
| `Local Checkpoint Handler.md` | **Adapt contract/tests** | Last six milestones and bounded recovery context are implemented here with scope checks. Existing atomic/revision tests are retained. |
| ABR-11/ABR-12 research documents | **Reference only** | Session portability and source provenance inform future adapters, not permission to copy private native session content. |

Separate issues: ABR-91 (Factory Brain), ABR-92 (trusted memU evolve/commit),
ABR-93 (embedding and reranker evaluation), ABR-99 (DesktopCommander tool
milestones and submission adapter). Do not implement these features twice.

## Milestone M1 behavior

- `memory/verified-recovery.mjs` accepts a **bridge-verified request scope**
  containing tenant, agent, repository and issue. A prior checkpoint must
  contain the exact same four dimensions and a prior job key. Legacy unscoped
  records remain on disk but are **not injected into prompts**.
- The Linux task-preparation path records attribution at verified admission and
  renders bounded context only when the scope matches. Subsequent progress
  updates preserve attribution rather than losing it.
- At most six saved milestones are included; text is sanitized and the whole
  preamble is capped at 2,800 characters (not a promise of an exact token count).
  Expired records reveal no saved work instructions or milestones.
- The recovery text is explicitly labelled non-authoritative and requires
  rechecking Linear, Git state, tests and permissions before acting.
- A new agent or tenant may replace the **legacy repo+issue checkpoint file** at
  new admission. This milestone prevents cross-scope *prompt injection* but
  does **not** independently isolate persistent per-agent files or authenticate
  disk contents. Durable storage isolation requires a separately designed
  migration; do not present this guard as a complete tenant security boundary.

## Verification

Run from a clean checkout with a writable process-local temporary directory:

`node --test memory/verified-recovery.test.mjs linear-agent-bridge/active-task-memory.test.mjs memory/local-agent-checkpoint.test.mjs memory/opencode-session-checkpoint.test.mjs`

Also run the bridge/reliability suites in CI. The Ubuntu host currently has
`/tmp` permissions 0755 (root-owned), which prevents the `bridge` user
from creating test fixtures there. For isolated checks use a `bridge`-owned
`TMPDIR`; do not change the host's global `/tmp` permissions here.

## Next implementation gates

1. Validate the **real** OpenCode 1.19.5 plugin API, context telemetry, and
   threshold fixture before wiring compaction; budget trigger must account for
   actual model context, fixed/tool overhead, output and tool reserves.
2. Agree on the durable four-dimensional checkpoint storage/authorization
   boundary, with legacy checkpoint migration and crash/restart tests.
3. Implement ABR-17 submission ingress only with real injected GitHub, Linear
   and Worker clients, capability-bound session identity, durable outbox and
   verified PR/review evidence.
4. Review additive PostgreSQL migration against actual live PG version,
   schema and roles; run disposable DB tests first. No production SQL, deploy,
   restart, secret rotation or memory promotion in this milestone.
