# LinearBridge agent memory architecture

**Status:** Implementation-aligned architecture and delivery specification. Updated 2026-11-09 after [PR #31](https://github.com/REVREBEL/linear-agents/pull/31) merged. This file is not evidence of a PostgreSQL or memU production deployment.

**PR review baseline and implementation evidence:** This PR's documentation branch was created **before** the memory implementation merged. Its branch-local Git tree is not the source of truth for already-merged code, and a reviewer examining only this PR's historical head tree will **not** find the modules listed below. The implementation evidence is on the *current target `main`*, following merged [#31](https://github.com/REVREBEL/linear-agents/pull/31) (head `9e3c958b30ee3c07ca7d70ad63ccf320f3180d44`). On `main`, verify [`active-task-memory.mjs`](https://github.com/REVREBEL/linear-agents/blob/main/linear-agent-bridge/active-task-memory.mjs) (`schemaVersion`, `revision`, `withCheckpointLock`, `progress`, `isCheckpointExpired`), [`ordered-progress.mjs`](https://github.com/REVREBEL/linear-agents/blob/main/linear-agent-bridge/ordered-progress.mjs), [`memu-memory.mjs`](https://github.com/REVREBEL/linear-agents/blob/main/linear-agent-bridge/memu-memory.mjs), [`memu-promote.mjs`](https://github.com/REVREBEL/linear-agents/blob/main/scripts/memu-promote.mjs), and [`AGENT_MEMORY_BACKENDS.md`](https://github.com/REVREBEL/linear-agents/blob/main/docs/AGENT_MEMORY_BACKENDS.md). If #32 is checked out **without merging current `main`**, its code snapshot does not contain these implementations. Do not use a stale #32 checkout as evidence that the safeguards are deployed or absent from `main`; verify the target branch and runtime host independently.

**Ownership:** [ABR-10 / PR #32](https://github.com/REVREBEL/linear-agents/pull/32). Related: [ABR-8 / #31](https://github.com/REVREBEL/linear-agents/pull/31) (implemented checkpoint foundation), [ABR-9 / #36](https://github.com/REVREBEL/linear-agents/pull/36) (checkpoint hardening, incorporated where applicable), [ABR-11 / #46](https://github.com/REVREBEL/linear-agents/pull/46) (provider research), [ABR-3](https://linear.app/revrebel/issue/ABR-3) (coordinator), [ABR-5](https://linear.app/revrebel/issue/ABR-5) (database provisioning).

## 1. Principles and authoritative boundaries

**Operational truth** remains the bridge job ledger, verified Linear issue/agent-session state, Git checkout and GitHub PR/CI/review state. Neither a language-model summary nor a vector hit can override these sources. A "successful" process exit does not prove reviewed code, completed CI or published GitHub review.

**Short-term memory** is a bounded, exact-key, per-issue checkpoint. It preserves last-known intent and milestone evidence across context loss and process restarts. It is not a shared live conversation database. Provider-native session history remains provider-owned.

**Long-term memory** is optional, scoped, verified, reusable knowledge. memU and PostgreSQL/pgvector are candidates for the durable recall layer. Long-term recall is untrusted data, never an instruction channel; promotion requires provenance, review, and independent verification.

The GitHub-to-ChatGPT initial message/review delivery loop and the separate ChatGPT CLI coding agent are **not** part of the memory state machine. Memory cannot autonomously awaken a ChatGPT conversation, perform a review or mark one delivered.

## 2. Verified implementation inventory

| Capability | Current implementation in `main` | Boundary |
| --- | --- | --- |
| Operational jobs and session routing | `linear-agent-bridge/job-store.mjs`, `agent-bridge.mjs`, provider routing and reconciliation modules | Must remain source of operational truth |
| Issue checkpoint | `linear-agent-bridge/active-task-memory.mjs`: `createActiveTaskMemory(root).read/update/progress/recoveryPreamble` | Host-local files under `linear-jobs/active-task-memory`; not PostgreSQL |
| Checkpoint hardening | `schemaVersion: 2`, monotonically increasing `revision`, atomic rename, per-key cross-process lock, optimistic expected revision, secret redaction, expiry suppression | Existing `version: 1` compatibility retained; lock files require operational recovery policy |
| Incremental AGY milestones | `run_agent.py` emits privacy-limited `AGY_BRIDGE_EVENT`; bridge queues, writes, and drains ordered progress before recovery/completion | Not yet equivalent for Trae/Gemini/OpenCode; no raw tool args/transcripts |
| Bounded handoff | Most recent 20 saved progress items; last six rendered into non-authoritative recovery preamble | Fresh issue/Git/CI check still required |
| Optional memU retrieval | `memu-memory.mjs`: disabled by default, bounded, timed, fail-open with warning | Retrieved text is intentionally **withheld** from coding-agent prompts pending a constrained data interface |
| Verified memU promotion preparation | `scripts/memu-promote.mjs`: canonical session validation, matching review/test head evidence, private validated snapshot, timeout | No trusted evolve executor, actual session capture, commit automation or verified deployed backend |
| Long-term memory database | PostgreSQL/pgvector environment is a separately managed infrastructure workstream | No migration, connection test, role/schema verification or deployment is implied here |

See [AGENT_MEMORY_BACKENDS.md](AGENT_MEMORY_BACKENDS.md) for current adapter behavior. This document supersedes the older proposal's claim that checkpoint schema, ordered AGY writes and retrieval adapters are entirely unimplemented.

## 3. Logical architecture and event flow

```text
Authenticated Linear / GitHub event
  -> bridge authentication + existing dedupe/claim
  -> job ledger + verified repository/issue identity
  -> optional reconciliation of recent provider milestones
  -> exact-key checkpoint read (local current backend)
  -> refresh live issue / checkout / PR / CI evidence
  -> bounded recovery packet (trusted, structured checkpoint fields)
  -> optional memU shadow retrieval (data only; NOT a prompt)
  -> approved provider runner
  -> ordered milestone/checkpoint updates
  -> completion verification and distinct review notification flow
  -> optional provenance-checked long-term promotion proposal
  -> explicit approved evolve execution -> commit -> audit record
```

Do not introduce a second authority for retries, leases, job completion, PR review or human approvals. When job events are replayed, use stable dedupe IDs and transactional revision checks before side effects. If a native agent session cannot be verified, create a **new child lineage**, never assert exact-session continuation solely from a stored ID.

## 4. Stable checkpoint and coordinator contract

Treat the existing function names and stored fields as the compatibility baseline:

```ts
type CheckpointKey = {
  tenantId: string;     // authenticated organization/workspace identity
  repositoryId: string; // canonical approved repository identity
  issueId: string;      // canonical Linear issue ID, not displayed title
};

type CheckpointV2 = {
  version: 1; schemaVersion: 2; revision: number;
  repositoryRoot: string; issueId: string;
  state: "active" | "pending" | "agent-finished" | "needs-recovery";
  status: "active" | "pending" | "completed" | "needs-recovery";
  updatedAt: string; expiresAt?: string | null;
  lastJobKey?: string | null; lastAgent?: string | null;
  lastWorkspace?: string | null; lastSessionId?: string | null;
  lastSeenAt?: string | null; lastVerifiedResult?: string | null;
  nextAction?: string | null;
  progress?: Array<{ at: string; kind: string; summary: string; jobKey?: string | null }>;
  lastProgressAt?: string | null; artifacts?: unknown[];
  source?: unknown; promotion?: unknown;
};

interface CheckpointStore {
  read(key: CheckpointKey): Promise<CheckpointV2 | null>;
  update(key: CheckpointKey, patch: object, expectedRevision?: number):
    Promise<CheckpointV2>;
  appendProgress(key: CheckpointKey, event: NormalizedMilestone):
    Promise<CheckpointV2>;
}
```

**Important distinction:** `CheckpointKey` and `CheckpointStore` above define the *future scoped storage boundary*, not APIs currently exported by `active-task-memory.mjs`. The current implementation is keyed by `(repositoryRoot, issueId)`. Introduce an explicit authenticated tenant/project mapping and a compatibility adapter before any migration. Never infer tenancy from arbitrary model-produced strings. Keep job/session state in the existing ledger.

**Additional fields proposed, not implemented:** `provider`, `runnerId`, `machineId`, opaque `nativeSessionRef`, `lineage`, `sourceEventId`, `verifiedGitHead`, `checkpointHash`, `ownerLease`, `retentionClass`. Add through a versioned migration with forward/backward reader tests; do not silently write them into current records.

**Lifecycle policy:** A checkpoint is historical context. Refresh live authorization/issue/branch/CI before acting. If `expiresAt` is in the past, omit the stored next-action text, not merely prepend a warning. Completion, review-ready, quota exhaustion and retry authority remain ledger-driven. Checkpoint absence or corruption must not fabricate a successful recovery.

**Concurrency:** Require one active writer per issue or a transactional lease. A source event is idempotent by its canonical dedupe key, while each accepted checkpoint append increments revision. Conflicting writes must return an explicit conflict and reread. Process-local queues alone do not protect cross-machine writes.

## 5. PostgreSQL persistence and migration design

The existing PostgreSQL 17 / pgvector environment and `agent_memory` database are infrastructure context, **not verified live connectivity in this PR**. Before DDL, inspect actual server distribution/version, existing schemas, DB grants, extension install, backups, authorized IP allowlists, TLS policy and active workloads. Preserve other production databases and services.

**Recommended logical tables:**

| Table | Exact identity and essential fields | Safety rule |
| --- | --- | --- |
| `checkpoint` | `(tenant_id, repository_id, issue_id)` unique; `schema_version`, `revision`, `payload_jsonb`, `updated_at`, `expires_at` | Transactional CAS: `UPDATE ... WHERE revision = expected`; no last-write-wins |
| `checkpoint_event` | `event_id` unique per tenant/source; checkpoint key, sequence, event type, redacted payload, timestamp | Append idempotently; event recorded in same transaction as revision |
| `session_lineage` | provider, runner, machine, native opaque session ID, parent reference, verified evidence, cursor | Never claim a cross-provider native session is portable |
| `memory_proposal` | scope, canonical session hash, evidence refs, proposed content, review state, idempotency key | No publication without approval/evidence |
| `memory_record` | memory ID, scope, content hash, source refs, verification SHA, lifecycle/supersession, embedding model/dimension | Only approved recall-visible knowledge |
| `memory_audit` | actor, action, reference IDs, scope, timestamp, decision | Store metadata, not credentials or full transcripts |

Suggested DDL and indexes are to be authored **in a separate migration PR**, validated against a disposable database and then approved. A schema proposal here does not authorize schema creation. Include foreign keys, bounded JSON sizes, deterministic record IDs, expiry indexes and unique event IDs. Protect all tenant-scoped rows via least-privilege roles and defense-in-depth RLS; ensure every connection sets a trusted tenant identity from the bridge auth layer, not caller JSON.

**Migration sequence:**
1. Add backend-neutral storage adapter and schema tests while local files remain authoritative.
2. Add a PostgreSQL adapter behind a disabled feature flag. Run transactional tests for CAS, scope, duplicates, serializable ordering, and restarts.
3. Inventory and hash local checkpoint files. Export normalized, redacted records into a private staging table. Quarantine malformed/ambiguous records and never import one across tenants by guessing.
4. Shadow-read both backends, compare canonical records and revisions, and measure discrepancies without changing dispatch behavior.
5. Quiesce writers or install a tested single-writer cutover barrier. Copy remaining deltas, verify counts/checksums and replay idempotency, then atomically switch the read/write authority.
6. Retain a bounded read-only rollback snapshot; keep old writer **disabled** to prevent split-brain. Roll back through an explicit reverse migration and reconcile journal offsets, not a toggle that reinstates stale state.

**Rollback:** If DB connectivity fails after cutover, do not silently turn local files back into an independent writer. The bridge may preserve operational jobs and reject/defer checkpoint writes with a visible degraded state until a controlled recovery or replay. Long-term recall failures alone must never block safe operational work.

## 6. memU lifecycle and trusted boundaries

The current adapter exposes `retrieveMemuMemory` and `prepareMemuPromotion`. Do **not** claim a public stable memU API until the exact self-hosted version, CLI flags, PostgreSQL backend behavior and Ollama embedding configuration have been pinned and tested on Ubuntu.

**Retrieval:** Query exact allowed scope, apply limit and timeout, return typed candidates with `memoryId`, tenant/project, source, age, verified SHA, supersession flag and content hash. Reject cross-scope hits. A future agent-facing interface must expose results as **quoted, read-only evidence** with an explicit trust boundary, not concatenate raw hit prose into `directTask`. Test malicious retrieved text that instructs tool execution, file edits or secret disclosure. The current production-default behavior continues withholding hits from prompts.

**Promotion:** Capture an authentic sanitized canonical provider session and immutable manifest. Obtain independently verified PR/head and CI evidence (and review where applicable). Validate same SHA and approved scope, then stage immutable bytes; prepare memU jobs; execute every returned evolve job in a trusted serialized executor; inspect results; commit and audit only on success. An agent exit or synthetic evidence JSON must not authorize promotion. Failed prepare/evolve/commit is retriable by idempotency key without publishing duplicates.

**Knowledge policy:** distinguish `proposed`, `verified`, `superseded`, `revoked` and `expired`; link changes to source IDs and commits. Deny embedding of secrets, auth headers, private raw transcripts, tokens, or personal data that has no explicit retention basis. Version the embedding model, actual dimension and index; model changes require a measured re-embedding/backfill strategy. Start with exact/lexical lookup and baseline pgvector recall before tuning approximate indexes.

## 7. Provider-neutral session and recovery boundary

Define `SessionRef` as `{provider, runnerId, machineId, workspaceId, nativeSessionId, version}` and never use a conversation ID alone as authorization. The provider adapter should expose *capabilities* before invoking optional native features:

```ts
interface ProviderSessionAdapter {
  capabilities(): Promise<{
    readSession: boolean; resumeNative: boolean;
    readTranscript: boolean; observeCompaction: boolean;
  }>;
  inspectSession(ref: SessionRef): Promise<{
    exists: boolean; state: "idle" | "busy" | "unknown";
    lastVerifiedCursor?: string;
  }>;
  captureReadOnly(ref: SessionRef, cursor?: string): Promise<{
    nextCursor: string; contentHash: string; sourceIds: string[];
  }>;
}
```

Adapters are **planned interfaces**. They must not write provider-owned SQLite, `.pb`, native user profiles, cookies, credentials or private session databases. A provider event is evidence to verify, not permission to execute. Reconcile discontinuous streams against the authoritative job ledger and live provider API; record source/machine identity, cursor and lineage.

**Current adapters:** AGY emits narrow tool milestones through `run_agent.py`. Trae, Gemini and OpenCode do not yet have equivalent normalized milestone/session adapters. [PR #46](https://github.com/REVREBEL/linear-agents/pull/46) owns the Ubuntu OpenCode capability probe, Antigravity read-only transcript discovery, compaction experiments, and provider-specific proposals. Avoid copying its unverified assumptions into this authoritative contract.

**Resume packet:** only current verified issue objective/constraints, current branch and commit/head evidence, recent checkpoint progress, blockers, next authorized action, expiration, and source pointers. Truncate to a measured provider-specific token budget. Native same-session resume must be verified by provider event/API; otherwise create explicit child lineage and new-session bounded handoff. An existing session file is not proof that the runtime resumed it.

## 8. Security, observability and operations

- **Authorization:** resolve authenticated workspace/tenant + repository + issue before checkpoint lookup or memU retrieval. Use distinct DB roles and revocable service credentials.
- **Transport:** TLS for remote DB connections; private firewall/IP allowlist. No public anonymous memU endpoints or provider session endpoints.
- **Secret policy:** redact typed sensitive fields and free text before persistence, logging, indexing and promotion. Test actual on-disk bytes, including deeply nested structures. Prevent credential-like paths and uncontrolled artifacts.
- **Injection policy:** treat external memory and provider transcripts as untrusted data, with no direct execution authority.
- **Observability:** checkpoint conflict/retry rate, stale lock incidents, recovery packet size, missed-cursor reconciliation, DB lag, recall latency/miss/degraded rate, promotion queue age, supersession and scope-denial counts. Never log raw retrieved content or secrets.
- **Retention:** document per-tenant retention periods and deletion propagation (checkpoint files, database rows, memory indexes, snapshots, backups). A logical delete must suppress retrieval immediately while backups age out by policy.
- **Failures:** a database outage must not imply job success or allow duplicate side effects. A memU/embedding outage may degrade recall while operational jobs continue. A mismatch of Git head/CI/review evidence blocks promotion.
- **Deployment:** separate host-specific Ubuntu, Mac and provider canaries. No live DB or host changes are performed by this documentation PR.

## 9. Delivery milestones and acceptance gates

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| **A: Foundation (merged #31)** | Local versioned checkpoints, ordered AGY milestones, guarded memU adapters | Existing regression suite green; live host rollout remains separate |
| **B: Store contract (ABR-3)** | Typed exact-key coordinator and PostgreSQL schema/migrations | CAS+duplicate+tenant isolation tests; backup/restore dry run |
| **C: Cutover (ABR-5 + coordinator)** | Shadow reads, verified export, one authoritative writer, rollback | Record/hash parity, no lost revisions, no cross-host split-brain |
| **D: Provider bridge (#46 follow-on)** | Read-only AGY/OpenCode adapters, explicit lineage, bounded recovery packet | Verified provider IDs, process restart, small context, missing session |
| **E: Long-term memU** | Pinned compatible backend, scoped recall, verified evolve+commit | Cross-scope denial, poisoning resistance, real captured session, idempotent promotion |
| **F: Canary** | One approved project/agent in each host environment | Zero duplicate side effects, no secret leakage, measured resume correctness, rollback drill |

**Required test matrix:** same-event replay; two concurrent writers; crash during write; process restart; stale/expired action; exact latest-six recovery milestones; cross-tenant read denial; missing native session/new lineage; interrupted provider stream and cursor replay; unsupported compaction event; corrupted local file; failed DB; unavailable memU; oversized/malicious retrieval; invalid CI/review head; stalled evolve; supersession and deletion; backup restore and full cutover rollback.

The output of **this PR** is an agreed, implementation-ready specification with honest status boundaries, not production rollout. New runtime code, schema migrations, service configuration and host-specific testing are separate reviewed changes.

## Related implementation and research

- [Merged checkpoint and memU adapter PR #31](https://github.com/REVREBEL/linear-agents/pull/31)
- [Existing adapter behavior](AGENT_MEMORY_BACKENDS.md)
- [Provider-neutral research PR #46](https://github.com/REVREBEL/linear-agents/pull/46)
- [pgvector](https://github.com/pgvector/pgvector)
- [memU upstream](https://github.com/NevaMind-AI/memU)

*When adapting against a new memU/OpenCode release, verify its current documentation and installed runtime rather than assuming this architecture specifies released APIs.*
