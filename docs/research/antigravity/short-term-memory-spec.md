# ABR-11 / ABR-13: Short-Term Agent Memory v1 Engineering Specification

**Status:** Phase-1 implementation-ready provider recovery proposal, aligned 2026-11-09 with merged PRs #31 and #32. **Provider adapters, native resume, PostgreSQL cutover and production canaries are not deployed or validated.**  
**Project:** Antigravity Session Intelligence & Recovery (P-ABR-34).  
**Related:** ABR-3 (storage coordinator), merged PR #31 (checkpoint foundation), merged PR #32 (architecture), closed PR #36 (unsafe alternative lock); ABR-11 (source analysis), ABR-12 (risks), ABR-13 (component selection), ABR-14 (rollout).  
**Target repository:** `REVREBEL/linear-agents`; **no second service/repo unless justified**.  
**Providers:** Antigravity (Ubuntu development, eventual Mac validation), OpenCode (Ubuntu, including local Ollama/Qwen with ~16k configured context), future providers via adapters.

> **Implementation baseline:** PR #31 merged the versioned local checkpoint, cross-process fail-closed lock, ordered AGY milestone recording and bounded recovery preamble. PR #32 merged the authoritative storage/memU architecture. PR #36 was **closed unmerged** because its stale-lock reclamation has unsafe races. Do **not** port its directory-reclamation/heartbeat code. This specification proposes *new provider adapters* and migration interfaces, not permission to change production hosts.

## 1. Definition of done

A coding agent can recover an authorized Linear task after context compaction, crash, lost native session, or same-issue follow-up **without inventing progress, rerunning non-idempotent work, losing active issue/PR identity, or requiring a whole transcript in its context**.

The system MUST:
- Persist task objectives and decisions **outside** model context and native provider transcript as a bounded versioned operational checkpoint.
- Keep exact job/issue/PR IDs, ownership, provider session ID, workspace identity, last verified commit and tests.
- Resume the **same** native session only when provider explicitly reports matching ID and scope. Otherwise start a new session with a parent lineage and an accurate brief.
- Provide on-demand, scoped, cited retrieval of earlier context, not full-history prompt injection.
- Survive bridge and provider restarts, duplicate events, crashes mid-step, missing providers, and memory backend outages.
- Reconcile GitHub PR/review/CI and Linear issue live state before executing an expired or disputed next action.
- Support small local-model windows by allocating explicit token budgets and compacting before overflow.
- Expose review-ready events to the existing authenticated GitHub/Linear → ChatGPT handoff **without claiming a webhook transport ack means ChatGPT reviewed**.
- Never automatically execute a retrieved historical instruction.

## 2. Authoritative boundaries and existing code

| Existing module | Keep | Extend via |
| --- | --- | --- |
| `linear-agent-bridge/job-store.mjs` | job receipt, dedupe, transitions and startup interruption reconciliation | read-only lookup + idempotent event/outbox linkage |
| `linear-agent-bridge/active-task-memory.mjs` (merged #31) | issue+repo operational checkpoint, v2 revision, redaction, bounded progress, expiry and fail-closed lock | add v3-compatible typed adapter and migration tests; no competing writer |
| `linear-agent-bridge/github-task-memory.mjs` | PR review digest and actionable event state | link checkpoint to issue/job and observed head |
| `linear-agent-bridge/agy-conversation-state.mjs` | AGY explicit resume bookkeeping | provider-neutral session ref companion, do not replace AGY path blindly |
| `linear-agent-bridge/run_agent.py` | AGY runner and observed IDs, exhaustion events | adapter observation and exact session verification |
| `docs/AGENT_MEMORY_REVIEW_LOOP.md` | source-of-truth and review delivery distinctions | update only after tested changes |

No memU vector result is an authority to dispatch, merge, or modify live files. Postgres `agent_memory` with pgvector is later durable backend; **transactional exact-key storage is the priority**, vectors are for historical recall.

## 3. Components and boundaries

New modules (proposed, subject to verifying current repo layout):
- `linear-agent-bridge/memory/contracts.mjs`: schema validators; provider/session/checkpoint types.
- `linear-agent-bridge/memory/provider-registry.mjs`: explicit allowed `provider + runner + machine + workspace` mapping; no auto discovery of arbitrary paths.
- `linear-agent-bridge/memory/providers/antigravity.mjs`: read-only session metadata and checkpoint hooks using runner-emitted IDs; optional JSONL artifact reading under verified approved directories.
- `linear-agent-bridge/memory/providers/opencode.mjs`: version-gated authenticated OpenCode API client, read-only session retrieval, status/events, native resume when supported.
- `linear-agent-bridge/memory/recovery-packet.mjs`: bounded deterministic context builder; no LLM to decide task authority.
- `linear-agent-bridge/memory/context-budget.mjs`: model budget, reserve calculations, trimming logic and diagnostics.
- `linear-agent-bridge/memory/reconciler.mjs`: restore durable event cursors and compare live provider/Linear/GitHub after downtime.
- `linear-agent-bridge/memory/snapshot-store.mjs`: optional immutable sanitized, content-addressed artifacts with scoped provenance.
- `linear-agent-bridge/memory/recovery-coordinator.mjs`: orchestration only, delegates authority/writes to checkpoint and job stores.
- `linear-agent-bridge/memory/outbox.mjs`: durable review-ready notification intent, dedupe and delivery result, **integrated with existing PR-review event pipeline**, not new messaging service.

Do not instantiate any of these for the Mac runtime until approved. Linux/OpenCode adapter may be tested against mock APIs.

## 4. Identity and scope schema

Use JSON Schema/AJV or equivalent runtime validation on every ingress. Strings must be nonblank and bounded; no arbitrary object blobs accepted as checkpoint patches.

```ts
type SessionRefV1 = {
  provider: "antigravity" | "opencode";
  runnerId: string;        // trusted registry entry
  machineId: string;       // stable enrolled host ID, not just hostname
  workspaceId: string;     // canonical configured project key
  repository: string;      // canonical owner/repo
  providerSessionId: string; // exact provider-reported ID
  providerVersion?: string;
  modelId?: string;
};
type EvidenceV1 = {
  source: "git" | "ci" | "linear" | "github" | "provider" | "bridge";
  observedAt: string;       // ISO UTC
  revision?: string;        // SHA / event ID / provider cursor
  uri?: string;             // approved citation URL or scoped artifact ref
  summary: string;          // sanitized, length-bounded
};
type ActiveCheckpointV3 = {
  schemaVersion: 3;
  revision: number;
  repository: string;
  issueId: string;          // current ABR identifier; prefer UUID cross-renames
  jobKey: string | null;
  ownerRunnerId: string | null;
  session: SessionRefV1 | null;
  previousSessions: Array<{ provider: string; sessionId: string; reason: string }>;
  state: "pending" | "active" | "agent-finished" | "needs-recovery" | "review-ready";
  lastVerifiedHead: string | null;
  prNumber: number | null;
  verifiedTests: Array<{ cmd: string; result: "pass" | "fail"; head: string; observedAt: string; machineId: string }>;
  objective: string;
  constraints: string[];
  completed: string[];
  blockers: string[];
  nextAction: string | null;
  expiresAt: string | null;
  lastAppliedEventId: string | null;
  evidence: EvidenceV1[];
  updatedAt: string;
};
```

`review-ready` can be an independent review substate if existing `state` enum cannot safely change; mapping must be explicit, **not** an unreviewed breaking change to merged #31. Never persist a giant transcript in `objective`, `completed`, or `evidence.summary`.

### Validation
- On update, derive issue/repository/runner/machine scope from authenticated job context, never from untrusted agent text.
- Reject cross-project session references even if provider IDs collide.
- Require `expectedRevision` (or server-managed CAS) for reads that precede writes; retry on conflict after re-read and reclassification.
- Maintain schema migration v1 → v2 (already merged) → proposed v3 that preserves `lastJobKey`, `lastSessionId`, `conversationId`, `idempotencyKey` and PR references.
- Unknown states/statuses fail closed, as implemented in merged #31.
- Require no raw API tokens, OAuth cookies or arbitrary secret-bearing free text. Use typed allowlists, secret scanning, bounded size, and persisted-byte tests; do not claim perfect regex coverage.
- Distinguish `completed` (agent exited) from `verified` (tests/CI observed on a particular commit).

## 5. Provider adapter contract

```ts
interface ProviderAdapterV1 {
  capabilities(): Promise<{
    listSessions: boolean;
    inspectSession: boolean;
    nativeResume: boolean;
    readHistory: boolean;
    compactionHook: boolean;
  }>;
  inspect(ref: SessionRefV1): Promise<{
    exists: boolean; state: "busy" | "idle" | "unknown";
    cursor?: string; observedAt: string; observedSessionId?: string;
    contextUsedTokens?: number; contextLimitTokens?: number;
  }>;
  readSince(ref: SessionRefV1, cursor?: string, limit?: number): Promise<{
    events: Array<{ id: string; kind: string; time: string; sanitizedSummary?: string }>;
    nextCursor?: string;
  }>;
  resume(ref: SessionRefV1, recoveryPacket: string, key: string): Promise<{
    accepted: boolean; observedSessionId?: string; verified: boolean;
  }>;
}
```

**Do not implement an unconditional `resume()` by sending a fresh prompt and labeling it 'same session'.** Check provider ID after invocation, workspace/repo mapping, and the observed event stream. If identity mismatches, record lineage and revalidate side effects.

### Antigravity implementation
- Use current `run_agent.py` explicit `--conversation` argument and actually observed provider conversation ID.
- Allow optional read-only parsing of `brain/**/.system_generated/logs/transcript*.jsonl` only on approved verified host roots; canonicalize paths, reject symlinks/path escape, cap bytes and parse line-by-line.
- Brain Hub `SessionScanner.ts` is a **research reference**, not a production dependency. Do not overwrite native `.pb` or JSONL stores or sync entire `~/.gemini`.
- On `on_exhaustion`, persist the exact session ref and `needs-recovery`, then use authorized cooldown scheduler. Do not emulate random IDE UI Retry clicks.

### OpenCode implementation (Ubuntu)
- Before work: verify actual installed `opencode --version`, `opencode db path`, model context config, auth and read-only session API; **do not dump DB/auth or create a clone**. Pin API version for tests.
- Use official OpenCode API/SDK to list/inspect messages/status, and stream events in a reconnectable subscriber. Event stream loss is reconciled against durable checkpoints and API, not assumed reliable.
- Use provider-native session continuation by exact ID when supported. Use read-only snapshot plus `newSession(parent)` fallback if the original cannot resume.
- Optional plugin hook `experimental.session.compacting` (verify available version) can append concise *verified* objective/progress; compaction callback must be time-bounded and degrade safely if bridge unavailable.
- Never modify `opencode.db` directly, never share writable SQLite across hosts. Native compaction is context maintenance, not job persistence.

## 6. Context budget and compaction policy

**Hard gate:** determine model's effective token capacity from actual provider request metrics and config. If reported `C`, estimate `F` = fixed system/tool/MCP overhead, `R` = output/reasoning reserve, `T` = expected next tool output reserve. Set input budget `B = max(0, C - F - R - T)`. Fail safely if `B` is insufficient. Do not treat Ollama `num_ctx` as full user history allowance.

Recommended **starting experiments only** for a measured 16,384-token Qwen setup:
- `R` at least 2,048 tokens, `T` 1,024–2,048 based on tool usage, `F` measured (not guessed).
- Recovery packet cap **1,000 tokens**, soft target 700. Recent exact message excerpt cap 1,500 tokens. Historical retrieval cap 1,000 tokens, zero by default.
- Trigger proactive checkpoint before predicted context crosses **65–70%** of effective input budget; do not assume provider offers pre-compaction telemetry. In absence of telemetry, checkpoint after important tool outcomes and each verified task milestone.
- If context/compaction fires: save checkpoint outside provider, include no more than current objective, last verified head/tests, blockers and safe next action in provider compaction context.
- Only fetch additional transcript excerpts or memU when a specific missing fact materially affects the next step; provide pointer+citation and bound output.
- If `F + R + T >= C`, reduce tool registry/tool output or choose larger model context; repeated compaction cannot cure an oversized fixed prompt.

All sizes/thresholds are tunable config defaults **to benchmark** on real Ubuntu OpenCode and AGY, not claims of tested optimum.

## 7. Exact checkpoint triggers

| Event | Write/action | Evidence requirement |
| --- | --- | --- |
| Authenticated job accepted | upsert issue checkpoint with exact identifiers and owner | bridge job key + Linear issue UUID |
| Provider session observed | bind session ref; persist verified ID | provider stream/API event, not guessed path |
| Significant user requirement changed | replace objective/constraints with source pointer | current Linear revision |
| Git commit or PR head observed | record last verified SHA; don't mark tests green | GitHub/Git source |
| Tests executed | record exact command, exit/result, SHA, machine and timestamp | captured process/CI result |
| Before compaction / context warning | flush bounded checkpoint, including blockers and remaining work | latest observed session cursor |
| Agent quota/timeout/crash | mark needs-recovery/interrupted and cooldown info | runner error classification |
| Agent marks done | mark agent-finished only, review-ready separately after evidence | process exit and actual GitHub head/CI |
| GitHub review changes or CI reports failure | update PR review checkpoint; dedupe handoff | signed event + current API state |
| Reconnect/restart | reconcile job, session cursor, Linear and GitHub | no duplicate side-effect execution |

Checkpoint update should be independent of memU availability. For writes, validate state and serialize/transactionally commit *before* acknowledging a non-replayable event.

## 8. Recovery algorithm, exact execution order

```text
recover(issueUuid, incomingEventId):
  1. Authenticate input and resolve authorized repository/project/runner.
  2. Deduplicate incoming eventId using durable journal; inspect previous delivery.
  3. Acquire issue execution ownership (no two active agents for one issue).
  4. Load checkpoint and job ledger; validate schema, scope, expiration, revision.
  5. Fetch current Linear issue; fetch GitHub PR head, reviews, CI; inspect Git checkout on target host only.
  6. Reconcile recorded vs actual commits/tests/side effects. On conflict -> needs-recovery + human review.
  7. Query provider adapter for sessionRef. If same ID/scope and resumable, attempt resume and verify emitted ID.
  8. Otherwise create new session with explicit predecessor lineage and bounded RecoveryPacketV1.
  9. Restrict nextAction to verified/current authorized instructions. Expired action text never enters prompt.
 10. Record resumed outcome, provider ID, new cursor and eventId by transactional write.
 11. Release issue ownership only after durable state handoff; route review-ready event through existing outbox.
```

No automatic rerun of a tool after timeout without idempotency proof or explicit user approval. A provider API `202` or process exit `0` is not a verified completed task.

## 9. Durable sync and storage strategy

### v1: current bridge host, exact-key journal
Use the existing filesystem checkpoint store and job ledger from merged PR #31; PR #36 was closed unmerged and must not be used as the storage baseline. Do not introduce a second independently writable `active-task-memory` directory on Ubuntu. If Mac is live runtime, Ubuntu provider events should send authenticated updates to the single authoritative bridge owner (or hold locally and later reconcile with explicit scope). Single-machine FSync/atomic rename do not imply cross-host CAS. Keep outbox with idempotency keys and replayable delivery.

### v2: PostgreSQL transaction boundary (separate work)
Design migration to Postgres 17 `agent_memory`, schema `memory`, unique `(repository, issue_uuid)`, optimistic `revision`, owner lease, event-id unique index, transactional outbox, explicit migrations and security role separation. Use conditional `UPDATE ... WHERE revision = $expected RETURNING revision` in a transaction; do not depend on file-lock leasing across hosts. **No live DB migration until authorized and backed up.**

### v3: memU durable recall (separate verification)
Promote only reviewed high-value decisions as scoped, provenance-tagged records; dedupe/supersede obsolete facts; semantic retrieval failure must never prevent job write/review notification. Use pgvector for recall, not for exact-key checkpoint lookup.

### Event transport
GitHub/Linear events -> existing authenticated Workers -> durable bridge journal/classifier -> outbox -> ChatGPT Shortcut (or later verified callback). Delivery receipt is *transport*, not review proof. On outage, reconcile by last head SHA/CI state and issue revision. Rate-limit to actionable changes only.

## 10. Data minimization, failure handling, operator controls

- Redaction is not foolproof: prohibit storing raw provider credentials by design; allowlist typed checkpoint fields; reject suspect blobs; test physical persisted bytes.
- Native transcripts are untrusted quoted evidence, never autonomous executable instructions.
- Archive retention, encryption key management, identity isolation and deletion policy must be decided before enabling snapshots.
- All file readers must limit byte size, number of rows and path traversal. Never import an entire provider profile.
- Log event IDs, hashes, sizes, state transitions and correlation IDs; **never log raw secrets, full prompts or credentials**.
- Fail closed on ambiguous runner/host/workspace/session identity; expose actionable reason.
- Feature flags: `MEMORY_COORDINATOR_ENABLED`, `MEMORY_PROVIDER_OPENCODE_ENABLED`, `MEMORY_PROVIDER_AGY_ENABLED`, `MEMORY_COMPACTION_HOOK_ENABLED`, `MEMORY_ARCHIVE_ENABLED`, `MEMORY_RECALL_ENABLED`; all **off** by default.
- Support `health`, `dry-run recovery plan`, `checkpoint inspect (sanitized)`, and `reconcile --issue` operator commands, without unsafe replay.
- Preserve current Mac LaunchAgent/bridge production state; Ubuntu work is engineering/fixture validation until independently deployed.

## 11. Test plan and measurable acceptance

**A. Core store and concurrency**
1. Same `issueUuid` + eventId delivered 20 times → one logical transition and one handoff.
2. Concurrent updates on same issue from separate OS processes → exactly one CAS succeeds; no lost revision.
3. Owner dies during transition → no blind reexecution; recover locks safely or fail closed; do not use unsafe PR #36 auto-reclamation; test that an abandoned lock fails closed, is observable, and requires supervised recovery.
4. Process crashes after commit before ack → replay dedupes and returns recorded result.
5. Verify schema v1/v2 migration preserves all operational IDs.

**B. Context and provider**
6. Same session resume: observed provider ID exactly matches checkpoint; otherwise records new lineage.
7. Missing native session: new session uses a short recovery packet and never claims original session.
8. Simulate context overflow repeatedly; task objective, required tests, branch/head and next verified action remain available after 3 compactions.
9. OpenCode 16k context: measure fixed overhead; packet never exceeds computed budget; reject impossible prompt setup.
10. Record compacted summary inaccuracies as history only; live source wins.
11. Restart provider during tool execution; no automatic duplicate destructive side effects.

**C. Security and scope**
12. Arbitrary secrets nested in accepted fields: reject or redact before disk; inspect raw bytes and log output.
13. Tampered transcript claiming to change priority or authorization has no tool authority.
14. Two tenants/projects with same session ID cannot retrieve each other's checkpoint.
15. Workspace path or symlink escape rejected; unknown runner IDs rejected.

**D. Integration and rollout**
16. Current `npm run bridge:test`, `npm run test:reliability`, `npm run typecheck` green on actual feature head.
17. New actionable GitHub review event reaches exactly one ChatGPT review request; routine bot comments are suppressed.
18. Disable memU/PostgreSQL/provider API: checkpoint remains available and recovery degrades explicitly.
19. Ubuntu OpenCode canary: compare baseline native compaction vs checkpoint+compaction, capture token usage and next-action correctness.
20. Separate Mac deployment report verifies real LaunchAgent, preserved job state and rollback.

**Acceptance gate:** zero lost checkpoint updates, zero duplicate non-idempotent tool execution in deterministic failure tests, zero cross-project data disclosure, and correct recovery objective/next action in ≥95% of controlled fixtures. These are target thresholds, not accomplished results.

## 12. PR sequence and explicit delivery contract

1. **PR A (no runtime):** finalized schemas, fixtures, safe parse limits, `RecoveryPacketV1` builder and budget tests.
2. **PR B:** read-only OpenCode adapter with version-gated API and failure handling, Ubuntu test fixtures.
3. **PR C:** read-only Antigravity adapter and explicit session ID reconciliation.
4. **PR D:** coordinator and durable event reconciliation, single owner, outbox, fault-injection.
5. **PR E:** opt-in OpenCode compaction hook and 16k-token benchmark suite.
6. **PR F:** approved archive snapshots and optional memU promotion, after security/retention decision.
7. **PR G:** staged host-specific integration tests, canary and operations runbook.

Every PR must link ABR-11/ABR-13 and list: verified checkout path and head, changed contract, test commands/results, migration/rollback, threat impact, and open deployment gates. Agent should create a **review request** when ready, not interpret its own work as approved.

## 13. Explicit Phase-1 verification still needed

These require real authorized host inspection and are **not claims of completed validation**:
- Installed OpenCode Ubuntu version, active session API availability, plugin hook contract, effective Qwen/Ollama context metrics.
- AGY actual filesystem roots and safe native session read; same-host native resume versus cross-host new session.
- Upstream license acceptance and source attribution before copying nontrivial code.
- PR #36 is closed unmerged. Current #31 fail-closed lock behavior and a safe supervised stale-lock recovery runbook before any new lock lifecycle changes.
- Actual Mac bridge deployment topology/ownership, and network path to future Postgres coordinator.

**Deliverable to AGY:** implement to these contracts only after Phase-2 review; do not infer unspecified behavior, silently create clones, access secrets, or deploy across hosts.

## 14. Reconciliation with merged implementation and acceptance ownership

**Already present in main (PR #31):** local `createActiveTaskMemory(root)` with `read(repo, issue)`, `update(repo, issue, patch)`, `progress(repo, issue, event)`, and `recoveryPreamble(record)`; v2 checkpoint revision and redact-before-write; bounded 20 milestones and latest-six recovery; AGY metadata-only tool events and an ordered ingestion queue; guarded memU retrieval and promotion preparation. Do **not** duplicate these APIs in `memory/` or claim they provide multi-host transactional authority.

**Architecture authority (merged PR #32):** the storage migration, tenants, PostgreSQL schema proposals, CAS semantics, retention, credential protection and memU promotion lifecycle. This specification owns the **provider-neutral read-only adapter, bounded recovery packet and exact-session verification**. If these documents conflict, the merged architecture is authoritative on storage/tenancy, and installed provider API probes are authoritative on actual capabilities.

**Implementation acceptance sequence:**
1. Add pure `SessionRefV1` and `RecoveryPacketV1` validation and deterministic unit tests. Preserve existing v2 checkpoint files and jobs.
2. Record a sanitized OpenCode Ubuntu host capability probe (version, authenticated API routes, actual session ID, context accounting), **without reading auth tokens or writing provider SQLite**.
3. Implement a read-only OpenCode adapter against a pinned API with synthetic missing-session/disconnect fixtures. No native resume claims until verified provider events.
4. Record approved AGY session roots and observed runner conversation IDs; implement read-only, path-contained discovery and malformed/transcript-size guards.
5. Implement reconciliation/lineage and context-budgeted new-session handoff behind disabled feature flags. Require same-session verification, dedupe and recovery tests before any production rollout.
6. Run distinct Ubuntu and macOS canaries, measure restart/compaction recovery and update the operational runbook. A CI pass on mocks is **not** live host proof.

No code in this research PR implements these six phases. The related Linear issues are the scheduling authority, and each subsequent runtime PR must document its exact scope and tests.
