# ABR-99 — Bridge-owned MCP milestones, guarded submission and review handoff

**State:** Source-only integration milestone. **No** new MCP/HTTP endpoint, live `submit_work` authorization, GitHub/Linear/Worker write, review notification, memory promotion, runtime service change or Mac agent installation. The existing Bridge job ledger and review inbox remain the only authorities. ABR-17 and ABR-18 are still **Backlog**, so production work submission and actual EventIntelligence delivery are blocked, not represented as completed.

## Verified inputs and source ownership

| Canonical component | Current behavior reused without duplication |
| --- | --- |
| [ABR-90 checkpoint](../../../memory/active-task-memory.mjs) | Per-repository/issue atomic file lock, revision CAS, secret redaction and bounded progress. ABR-99 extends its existing record to preserve server-verified MCP receipt hashes and the authoritative host/branch/repository identity across lifecycle writes. |
| [ABR-90 recovery](../../../memory/verified-recovery.mjs) | Four-dimensional tenant + agent + repository root + issue validation; at most six informative milestones, capped recovery context and explicit non-authoritative labeling. |
| [Job ledger](../../../jobs/persistence/job-store.mjs) | The single authoritative `get(jobKey)` source for current admitted job state; no extra job store, transition, dispatch or implicit trust of issue IDs, environment variables or checkpoint text. |
| [Review inbox](../../../bridge/orchestration/review-inbox.mjs) | Atomic durable `enqueue` keyed by the existing `githubReviewChangeKey` on repository/PR/action/full SHA, with separate pending → claimed → reviewed/blocked lifecycle. No second outbox or reviewer identity. |
| [Review verifier](../../../bridge/orchestration/review-delivery.mjs) | Existing review route must confirm a published GitHub review at exactly the queued head by the designated human review identity; MCP cannot claim ACK by itself. |
| [D5 context CLI](../../../scripts/agent-context-handoff.py) | Canonical source-linked, versioned full handoff envelope and `verify --check-source` remain the only permitted context attestation; an optional injected verifier is required for any envelope to be returned as verified. |

Existing source homes are preserved: `bridge/orchestration/mcp-milestone-integration.mjs` is a **library module**, not a second HTTP dispatcher; `memory/active-task-memory.mjs` retains existing CAS/write ownership; `bridge/orchestration/review-inbox.mjs` remains the persistent review queue.

### Operating modes

**Interactive MCP:** Cannot call `bindAdmittedJob` without separate trusted Worker → Bridge admission. Tool output, OpenCode/Antigravity prompt text, guessed job keys, `LINEAR_ISSUE_ID`, `LINEAR_AGENT_SESSION_ID`, client-supplied host or issue identifiers, and `submit_work` text are **never** accepted as an identity or a trigger for Linear/GitHub/memU side effects. Interactive file/process tool permissions remain governed by ABR-94–98 separately.

**Trusted Linear coding job:** Only a host-injected `verifyAdmittedJob` can mint a WeakMap-owned handle. The bridge must re-read `jobStore.get(jobKey)` at **every** tool milestone, recovery and submit operation. Its tenant, agent, repository ID + canonical root, issue, exact session, machine, branch and running/launching/awaiting_external state must match the verified admission. No stale/revoked capability can switch sessions or hosts. This source contract is deliberately stricter than the currently populated production job ledger; missing canonical fields (notably tenant/repository/branch/host) cause **fail-closed denial** rather than ad hoc inference. ABR-17 must arrange trusted admission enrichment before live use.

## Source behavior

1. `recordToolMilestone(handle, receipt)` accepts **only** a server-verified `verifyToolReceipt` result with the same job, session, host, tenant, agent, tool name/call ID and completion outcome. It redacts summary text, stores no raw transcript, limits visible progress to six items, and tags the narrative `trustedForDispatch:false`. It commits through the existing checkpoint update lock and revision CAS, with no job/PR/Linear/memU side effect.
2. Milestone idempotence is keyed by a SHA-256 of server-owned job/session/host plus verified toolCallId. A bounded history of 256 hashes lives **inside the existing checkpoint** and survives routine lifecycle updates. Duplicate receipts cannot increment checkpoint revision; conflicting recent receipt identities fail; when capacity is reached, further writes fail closed instead of silently forgetting old hashes and accepting replay.
3. `recoveryHandoff` re-checks ledger and checkpoint identity, then calls the existing `verifiedRecoveryPreamble`. It returns bounded, lower-trust context and job scope only; no executable instructions or authority.
4. `sourceLinkedHandoff` accepts a **complete** canonical D5 JSON envelope only when `verifyD5Handoff` is injected and affirms it with pinned Git/source verification. It requires matching repository, pinned Git HEAD and 40/64-hex hashes; a missing adapter, inconsistent revision, partial/forged or unknown source fails closed. The full artifact remains attached to the returned object, not replaced by a bare hash. It is context, never a new job capability. The existing D5 CLI tests validate the actual Python verifier independently.
5. `submitWork` requires an explicit **ABR-17 `submissionCoordinator.submit` implementation** plus a separate real GitHub/Linear `verifySubmittedPr` implementation and approved review route. Without those, `SUBMISSION_COORDINATOR_NOT_CONFIGURED`. The MCP caller supplies **only confirmed issue ID and summary**; job/branch/repository/session/host come from the verified ledger handle. On verified `in_review`, passing trusted checks, exact branch/issue/repository and full 40-hex SHA, it enqueues a `ready_for_review` event in the existing inbox. Repeat same PR/head returns the original review ID, changed head creates a new cycle. **Queued ≠ ChatGPT reviewer notified, started, acknowledged, GitHub reviewed, Worker completion or Linear Done.** The coordinator must own new PR creation, re-use/revision, external clients and independent session close before this method is enabled.

### Real operational prerequisites

**ABR-17:** Actual bridge-owned submission endpoint/CLI and scoped launcher capability; GitHub App installation/repository mapping; real GitHub HEAD/CI/PR verification; durable stages `received → ... → in_review → session_closed`, one PR per branch, correct Linear identity and Worker `/complete`. Neither dummy adapter nor placeholder success is allowed.

**ABR-18:** EventIntelligence consumer, deduped reviewer launch/ACK and sender suppression. ABR-99 can *queue* into existing review inbox only; live reviewer wake-up and activity verification remain separate and cannot be fabricated by an enqueue receipt.

**ABR-90/D5:** Authorize actual checkpoint attribution from trusted admission, invoke existing D5 source verifier in a host-trusted adapter, and maintain Git source/README hashes across remote/local handoffs. No new C3/C5 resolver is created here.

**ABR-96/97/100:** Real Ubuntu `bridge` AppArmor sandbox and approved macOS execution sandbox, production device enrollment, end-to-end authenticated MCP client, secure per-user/agent tool grants and review canary remain unapproved. The existing Mac `io.revrebel.agent-bridge`, Ubuntu `agent-bridge.service`, Synology, Cloudflare and Worker routes are not modified by ABR-99.

## Tests and review gate

`npm run mcp:bridge:test` uses **actual on-disk canonical job store + active-task checkpoint + review inbox** with disposable identities and explicitly injected fixture verifiers. Cases: no trust from interactive environment/tool output, ledger host/tenant/branch/issue/session mismatch, stale job and stale checkpoint, bounded sanitized milestone storage, durable replay after progress eviction/restart, concurrent CAS writes, expiry, non-authoritative recovery, guarded full D5 handoff, one queued review per PR/head, separate reviewer claim and verified-published outcome, blocked/failing submission, missing coordinator and missing route. No live GitHub, Linear, Worker or memU side effects.

`python3 scripts/test_context_handoff.py` exercises the **real** D5 pinned context creator/verifier; it is the source-of-truth, not the small JavaScript mock verifier injected into ABR-99 unit fixtures.

Read-only CI also preserves existing `bridge:test`, `test:reliability`, `mcp:profiles:test`, `mcp:oauth:test`, `mcp:devices:test`, `mcp:foundation:test` and context blueprint validation.

## Rollback / promotion

No production deployment is performed by this milestone. To revert the source milestone, remove its optional library, additive checkpoint attribution/receipt field and tests in a reviewed PR; do **not** delete the canonical checkpoint, job ledger, reviewer inbox or the existing D5 tooling. Once ABR-17 and ABR-18 are actually integrated and independently tested, require separate approved deployment/canary and observe queued vs launched/ACK vs reviewed/Done separately. Fail closed on unknown side-effect outcomes rather than automatically creating a second PR or session close.
