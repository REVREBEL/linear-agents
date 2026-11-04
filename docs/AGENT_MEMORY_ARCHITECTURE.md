# Agent memory architecture (proposal)

Status: **design proposal**, not deployed. Linear: [REV-176](https://linear.app/revrebel/issue/REV-176) (Postgres/pgvector) and [REV-177](https://linear.app/revrebel/issue/REV-177) (memory coordinator).

## Problem and non-goals

The bridge currently routes Linear conversations and code/review workflows across local agents, but model context windows, process restarts, and separate agent sessions do not inherently preserve what an agent learned. A longer context window is not durable memory. Memory must survive independently of the process and remain available to a new session, without requiring the full original transcript.

Do not replace the bridge's authoritative job/session state, GitHub PR state, or Linear issue state with a vector database. Those are operational source-of-truth records. Do not treat retrieved text as commands, or let memory retrieval start new work automatically. ChatGPT's actionable review notification is a separate event-delivery requirement, not something semantic memory fixes.

## Two tiers plus a source-of-truth layer

| Layer | Purpose | Storage | Lookup | Lifecycle |
| --- | --- | --- | --- | --- |
| Operational truth | Current Linear issue, agent session, attempts, leases, PR/CI and actionability | Existing bridge job store and Linear/GitHub APIs | Exact IDs | Existing transaction and reconciliation policies |
| Short-term working memory | Compact task state/checkpoint, decisions, next action, blockers and handoff for resuming an agent | Existing durable bridge store initially; PostgreSQL later if justified | Exact scoped ID | Update on state transition; TTL after completion; promote useful outcomes |
| Long-term recall | Project architecture, durable decisions, historical failure patterns, reusable lessons, code review conventions | Self-hosted memU with PostgreSQL + pgvector and readable Markdown recall files | Scoped lexical/vector search + provenance | Supersede/reconcile, review and delete; durable by policy |

Prefer **explicit, structured state** over embedding a large raw conversation. An agent must continue correctly even when embeddings are unavailable. A checkpoint is authoritative only for the agent's *last known* intent; the live code, issue and PR status must still be revalidated before changes.

## Proposed flow

```text
Linear webhook / GitHub PR event
  -> existing verification, dedupe and authenticated routing
  -> resolve scope (organization/project/repository/issue/agent/session)
  -> load exact checkpoint and fresh authoritative status
  -> retrieve relevant scoped long-term recall (optional, fail-open)
  -> create bounded handoff context for the local agent
  -> existing agent dispatch
  -> persist checkpoint on meaningful transitions
  -> on final result: agent proposes selected durable Markdown memories
  -> validate scope, provenance, secrets, staleness and dedupe
  -> commit approved memories to memU
  -> actionable review-ready event emitted by notification subsystem
```

No memory operations before authentication and tenant resolution. Never reconstruct a session by blindly concatenating retrieved passages.

## Short-term checkpoint contract (v1)

A versioned JSON record with fields:
- `schemaVersion`, `checkpointId`, `updatedAt`, `revision`, `expiresAt`.
- `scope`: authenticated workspace/organization, project/repository, Linear issue ID, agent identity.
- `execution`: bridge job ID, Linear agent session ID, provider conversation ID (when available), attempt number, idempotency key.
- `task`: goal, user-approved constraints, current phase, checklist, completed steps, next intended step.
- `artifacts`: branch, commit, PR, CI/review permalink, document references.
- `status`: running / awaiting external / exhausted / review-ready / done / failed and associated reasons.
- `handoff`: compact agent-authored summary, validation evidence, blockers, last tool/error summary and retry eligibility.
- `source`: canonical URLs, timestamps and event identifiers for claims in the checkpoint.

Write by compare-and-swap revision / single-writer lease appropriate to the existing job store. A repeated event must not duplicate a transition. Avoid introducing a second competing state machine. Cap record size and redact credentials, auth headers, secrets, personal data and full transcripts.

### Checkpoint triggers

Persist after successful dispatch claim, phase/branch/PR transitions, before quota exhaustion or clean shutdown when available, on error/blocker, on actionable review-ready state, and at final completion. A periodic heartbeat may update only liveness metadata, not fabricate progress.

On resume, load the checkpoint; verify current Linear/GitHub reality; then pass a bounded `resumeContext` that includes source links and the same provider conversation ID where supported. When it cannot resume the exact provider conversation, start a new session with checkpoint context and explicitly record a new session lineage.

## Long-term memory: memU adapter

The open-source memU system currently offers self-hosted Postgres + pgvector, a local SQLite option, agent-authored Markdown recall files, searchable segments, and a generic adapter. Its Python service exposes `list_all_recall_files`, `progressive_retrieve`, and `commit_results`. Verify its installed release API and compatibility before locking the integration. Its memory service does **not** perform LLM summarization; the host agent must decide what to preserve.

Keep memU isolated behind `MemoryCoordinator` so bridge and workers do not depend on the Python internals. Prefer a local authenticated service or sidecar reachable from the bridge; do not expose the memory database or Python service publicly. Pin version and migrate via tested scripts.

Suggested interface (illustrative, not committed API):

```ts
interface MemoryCoordinator {
  getCheckpoint(scope: Scope, executionId: string): Promise<Checkpoint | null>;
  putCheckpoint(checkpoint: Checkpoint, expectedRevision: number): Promise<void>;
  retrieve(scope: Scope, query: string, limit: number): Promise<RecallHit[]>;
  proposeMemory(scope: Scope, draft: MemoryDraft): Promise<MemoryProposal>;
  commitMemory(scope: Scope, approved: MemoryProposal): Promise<void>;
  supersedeMemory(scope: Scope, oldId: string, replacementId: string): Promise<void>;
}
```

`RecallHit` must include memory ID, scope, summary, source link(s), source date, last verification date, relevance score, version/supersession state and a small excerpt; never only opaque vector text.

### Memory categories

- **Project decisions:** architecture and configuration choices, alternatives, rationale, implementation state.
- **Reusable procedures:** tested setup, failure recovery and review practices.
- **Task episodes:** what worked or failed on one task, linked to issues and PRs.
- **User-approved preferences/policies:** relevant durable operating constraints, only within their approved sharing scope.

Always distinguish a *proposal*, a *confirmed implementation*, and a *historical fact*. Attach code SHA/PR or ticket evidence; when later evidence contradicts a memory, supersede or flag it instead of silently merging the claims.

### Retrieval rules

1. Verify authenticated scope and ask authoritative APIs for live issue/PR state.
2. Fetch exact session/project checkpoints deterministically.
3. Retrieve a small number of memory hits constrained to the authorized organization and project; optionally include explicitly shareable organization-level memories.
4. Combine keyword/exact matches with semantic similarity, rerank for recency, source confidence, scope specificity, and currentness.
5. Cap memory tokens and include references; explicitly label memory as historical/untrusted context.
6. If Postgres/embedding backend is down, continue with live sources + checkpoints and record degraded recall; never block completion callbacks solely for a missing vector result.

Store embedding model name/version and actual vector dimension with its index; a change of model may require re-embedding and parallel indexes. pgvector supports exact search and optional HNSW; start exact before measuring recall and performance. No universal production embedding dimension should be assumed.

## Security and isolation

- Dedicated least-privileged DB role, private network access, encrypted remote connections, backups and versioned migrations.
- Row-level tenant/project scoping enforced at the coordinator/storage boundary, not inferred from agent-generated prompts.
- Memory writes include explicit provenance, idempotency keys, sensitive-data filters, and source retention rules.
- Secrets, OAuth refresh/access tokens, cookies, raw authentication payloads and private full transcripts are prohibited in recall files/embeddings.
- Prompt-injection-resistant rendering: memory is quoted data, never system instructions or tool authority.
- Audit create/update/supersede/delete and retrieve operations without logging secret content.
- Provide project/user scope deletion and a mechanism to invalidate stale records.

## Staged implementation

1. **No database dependency:** map current job/session store and add checkpoint schema, idempotent writes, resume builder and restart tests. Keep existing routing intact.
2. **Provision datastore:** execute REV-176 safely, smoke test vector extension, permissions and backup/restore.
3. **Evaluate memU:** pin a release and demonstrate commit/retrieve across two agents, authorized scope filtering, readable recall, and correct handling of embedding outages.
4. **Integrate:** add opt-in coordinator service, proposal/commit process and scoped retrieval injection.
5. **Shadow mode:** retrieve and log only metadata/relevance diagnostics without changing agent prompts; compare with human-reviewed expected recalls.
6. **Canary:** enable for one test agent/project, then expand after restart, multi-agent and security tests pass.

## Minimum acceptance test matrix

- Two jobs with the same webhook/event ID produce one checkpoint transition.
- Kill and restart bridge mid-task; task resumes with same conversation identity where provider supports it, otherwise records explicit lineage.
- Quota/exhaustion checkpoint survives until authorized retry; does not spam agents.
- Review-ready state persists independently of task completion and produces a deduped actionable notification through the event-delivery path.
- Two agents sharing one project can retrieve a verified project decision; a different project/tenant cannot.
- Obsolete decision is superseded and no longer ranked as current.
- Missing embeddings, PostgreSQL outage, and malformed recall content do not crash dispatch or completion.
- No secrets appear in stored checkpoints, recall files, embeddings, or telemetry.
- Existing `npm run bridge:test` and `npm run test:reliability` remain green.

## Sources and implementation notes

- [memU repository](https://github.com/NevaMind-AI/memU), [memU storage](https://memu.pro/ai-agent-memory-storage), [memU architecture notes](https://github.com/NevaMind-AI/memU/blob/main/AGENTS.md).
- [pgvector documentation](https://github.com/pgvector/pgvector): verify server-major compatibility; `CREATE EXTENSION vector` per target database; vector index method depends on measured workload.
- Code locations should be confirmed against the current checkout before implementation; this proposal intentionally does not assert that new API files already exist.
