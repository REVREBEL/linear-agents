# ABR-11 | Recovery evaluation and implementation plan

**Phase 1 source dossier / candidate test strategy.** Do not merge this into a production rollout without Phase-2 approval. See [source inventory](source-inventory.md) and [architecture](architecture.md).

## What can be reused and why

| Source feature | Decision candidate | Reason / blocker |
| --- | --- | --- |
| Brain Hub multi-root transcript discovery, session metadata, JSONL parsing, mtime cache | **Adapt** | Good read-only pattern; verify actual directories, prevent path traversal; avoid IDE UI coupling |
| Brain Hub structured artifacts/plan/walkthrough enumeration | **Adapt** | Useful for verifiable “what was done” pointers without pasting entire chats |
| Brain Hub secret sanitizer and resilient parser tests | **Adapt tests only** | Generic regex cannot guarantee removal of arbitrary secrets |
| Brain Hub Git `add .` + local-preferred merge | **Reject for live session state** | Risk of raw transcript exposure and silent overwrite/conflict |
| Antigravity Sync include/exclude and watcher concepts | **Adapt with two-way allowlist** | Native data discovery is useful; incoming sync must never bypass filtering |
| Antigravity Sync `.pb` sync/restore | **Research-only** | Native session registration, account/index and path compatibility unproven |
| Antigravity Sync CDP Retry clicker | **Reject operationally** | Button retry lacks classification, dedupe, authorization and quota handling |
| OpenCode official session API and event stream | **Preferred provider adapter (subject to Ubuntu version check)** | Read-only enumeration and continuation can avoid private SQLite writes |
| OpenCode native compaction + `experimental.session.compacting` | **Adapt** | Enrich summary with verified task facts but preserve checkpoint independently |
| OpenCode raw `opencode.db` file replication | **Reject** | Provider-owned SQLite and secrets, unsafe for concurrent host writes |
| Existing bridge job store + issue/PR checkpoints | **Extend** | Already carries issue, job, callback and PR review identities |
| memU / PostgreSQL | **Separate track** | Promotes verified reusable knowledge, not immediate crash recovery |

## Step-by-step Phase 1: evidence

### A. Static analysis and pinned references
1. Verify upstream license, dependencies, code SHAs and source maps (see source-inventory.md).
2. For AGY: document official hooks and native data roots for App/IDE/CLI; enumerate JSONL records, artifact metadata and full vs compact transcript shape from **sanitized fixtures**. Compare actual runner-emitted conversation ID with native on-disk ID and checkpoint.
3. For OpenCode: use official API, plugins, compaction and storage documentation; confirm which features are in the **installed version**, not just latest online docs.
4. Compare against existing bridge's job ledger, active issue checkpoints, PR-review task memory, `agy-conversation-state`, and runner.
5. Produce state/permission diagram, secret/data-flow inventory, reconnection paths, and immutable archive rules.

### B. Ubuntu OpenCode read-only discovery checklist
Run only on the authorized host from its existing workspace. Gather **non-secret** output:
- `uname -s; hostname; pwd; git rev-parse --show-toplevel; git remote -v; git status --short --branch` in the authorized checkout (do not create new clones).
- `opencode --version`, `opencode db path` (path only; **never dump auth or DB**), and effective OpenCode config with secrets omitted.
- `ollama ps` and configured `num_ctx` (if Ollama-backed); record selected model, declared context window and actual per-request usage.
- Confirm whether authenticated OpenCode session API is running; test read-only session list/context/status. Use no unsafe unauthenticated external listener.
- Check availability of plugin hooks: `session.idle`, `session.compacted`, `experimental.session.compacting`; record an isolated *test session* sequence, avoiding live production chat edits.
- Establish actual fixed token overhead for system instructions, tool schemas, MCP descriptors and recent tool outputs. A 16k `num_ctx` setting does not equal 16k available for task history.

**Output:** `opencode-host-capabilities.md` with machine, binary/version, config capabilities, session API availability, model limit accounting, safe event evidence, and risks.

### C. Native Antigravity portability experiment (separate disposable session)
1. Create a disposable conversation with a distinctive non-sensitive marker and planned/verified task data; record native ID, transcript path, workspace and code commit.
2. Confirm its transcript visible in Brain Hub parser fixtures or dedicated read-only collector.
3. Restart the **same** provider instance and resume by exact ID; verify in returned events that ID is unchanged and references remain correct.
4. On a second machine, **do not copy native private profile or credentials**. Try a sanitized archived transcript plus bounded recovery packet in a *new* session; verify correctness and lineage.
5. Only if authorized, research controlled native state transfer in a throwaway profile; do not assume matching symlink paths alone establish native resume.
6. Test quota exhaustion, local process restart, and manual recovery while avoiding any auto-click approvals.

**Output:** measured outcomes split into same-host same-session, same-host new-session and cross-host/new-provider handoff. Mark unsupported semantics explicitly.

### D. Controlled 16k-context OpenCode experiment
Compare these scenarios with the **same reproducible small TypeScript task and tests**, isolated workspace and exact scoring rubric:
- Baseline: native auto-compaction, no bridge checkpoint injection.
- Checkpoint-only: bounded resume packet on fresh session (e.g. ~700-1,200 tokens initial experiment).
- Provider hook: enrich compaction summary with checked facts and pointers, no raw transcript dump.
- Combined: native same-session compaction **plus** durable checkpoint and selective retrieval.
- Failure: corrupted/missing native session, app crash, double-delivered event, long tool output, expired task action and model-context rejection.

Record real prompt tokens, fixed overhead, compaction cycles, time-to-recover, correct next action, duplicate work, wrong-host actions and secrets found. Proposed numeric token budgets are hypotheses, not blanket config advice. Carefully test `keep.tokens` and `buffer` using the **installed** OpenCode version; default V2 recent keep of 15k may not fit a model whose whole runtime context is 16k.

**Suggested scorecard:** ≥95% correct resume next action in deterministic fixtures; zero duplicate side effects, zero cross-project leakage, zero secret bytes in persisted packets, successful restart reconciliation and < a bounded measured resumption prompt budget. These are **acceptance targets**, not already achieved.

## Phase 2: decision and API design approval
- Confirm which provider adapter APIs are stable in actual Ubuntu OpenCode and AGY versions.
- Decide whether to use local checkpoint journal replication vs PostgreSQL transactions for cross-machine active writer authority. Avoid split-brain.
- Specify a portable `RecoveryPacketV1` typed schema, source citations, revision/Etag, content hash, expiry policy, token budget and encryption boundaries.
- Define provider plugin boundaries and bridge API: `provider.session.discovered`, `checkpoint.updated`, `compaction.started/ended`, `session.interrupted`, `recovery.requested`, `recovery.verified`; write to an idempotent bridge journal and reconcile after reconnect.
- Prepare exact PR sequence with stable tests, plan for macOS validation on the real Mac, and explicit cloud/DB deployment gates.

## Phase 3: proposed PR decomposition after approval
| PR | Deliverable | Principal test |
| --- | --- | --- |
| 1 | Typed provider-neutral `SessionRef`, `RecoveryPacketV1`, evidence/cursor/lineage schema | ID mismatch, scope isolation, over-budget/expired payload rejection |
| 2 | OpenCode **read-only** adapter using authenticated session API | session exists/missing; event disconnect; no provider DB write |
| 3 | AGY read-only transcript adapter + current runner ID reconciliation | actual ID vs transcript; wrong workspace; traversal; malformed JSONL |
| 4 | Bridge event journal reconciliation and bounded resume-packet builder | duplicate/reordered delivery, crash mid-task, conflicting owners |
| 5 | Optional OpenCode compaction plugin (version-gated, opt-in), thin prompt injection | context-budget, compaction loss, graceful plugin absence |
| 6 | Immutable, scoped archive manifest and selective memU promotion interface | serialization, rollback, secret scanning and provenance |
| 7 | Host-specific canaries on Ubuntu OpenCode and AGY, separate macOS rollout | actual end-to-end resume, CI/review event handoff, rollback |

Each PR should land behind disabled-by-default feature flags until the relevant target-specific test passes. No production copying of raw `.gemini/` or `opencode.db`.

## Non-negotiable acceptance
- Exactly-once logical transition from duplicate input (transport may retry).
- Correct issue and repo maintained through same-provider compaction, session restart, and cross-provider fallback.
- No stale next action executed without revalidation.
- No security bypass by instructions embedded inside retrieved transcripts or summaries.
- Linux engineering sign-off ≠ Mac runtime rollout sign-off.
- Verified GitHub PR-review ready notification reaches ChatGPT through a durable delivery mechanism independent of session storage.
- A provider session being *present on disk* does not imply it was resumed; corroborate via active API state/events.
- memU unavailability cannot block operational checkpoint writes or safe job completion.

## Source references (live docs, verified 2026-11-07)
- https://opencode.ai/docs/compaction/
- https://opencode.ai/docs/api
- https://docs.opencode.ai/docs/plugins/
- https://docs.opencode.ai/docs/troubleshooting/
- https://antigravity.google/docs/hooks
- https://github.com/chiriforge/brain-hub-antigravity
- https://github.com/mrd9999/antigravity-sync
- https://github.com/REVREBEL/linear-agents/blob/main/docs/AGENT_MEMORY_REVIEW_LOOP.md
