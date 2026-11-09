# ABR-11 | Provider-neutral short-term memory and recovery architecture

**Status:** Phase-1 research architecture aligned to merged PRs #31 and #32. Provider-neutral adapters are proposed, not deployed. See [source inventory](source-inventory.md) and [evaluation/implementation plan](recovery-plan.md).  
**Scope:** AGY on Ubuntu and macOS, OpenCode on Ubuntu with constrained model context, Linear/GitHub bridge; optionally other agent providers.  
**Non-goal:** treat semantic vector recall as the source of truth for a live job, or blindly migrate proprietary native conversation files.

## Problem decomposition: four failure classes

1. **Context overflow:** the model context fills; provider compacts or truncates tool outputs. Session may remain alive, but the model forgets exact decisions, constraints and test evidence.
2. **Provider restart/crash:** native conversation is persisted, but agent process or stream is gone. Recovery requires exact provider session identity and checking the current execution state.
3. **Cross-host or cross-agent handoff:** native histories may not be portable between AGY Mac, AGY Linux and OpenCode Ubuntu. Hand off *verified task state* rather than copying provider state into the wrong runtime.
4. **Transport/event gap:** GitHub/Linear events can be missed, duplicated, reordered or observed while a writer is down. Notifications and work delivery require a durable journal plus reconciliation; native conversation backups do not address this.

**Decision:** separate three stores:
- **Operational truth:** existing Linear Bridge job ledger and PR/issue checkpoints, exact keys and state transitions. Persistence may later move to transactional PostgreSQL; do not couple writes to embeddings.
- **Native context:** provider-controlled session IDs/messages/transcripts/summaries/compactions, read through provider-specific adapters and stored only as *scoped, immutable, sanitized snapshots* when necessary.
- **Reusable memory:** selected, independently verified architectural conclusions in memU/pgvector; never the only copy of current job or retry state.

## Proposed data flow

```text
                  Linear + GitHub (authoritative live intent)
                               |
                  authenticated Worker/event receiver
                               |
                    durable job/event ledger
                               |
             issue checkpoint + PR-review checkpoint
                               |
                RecoveryCoordinator (idempotent)
              /                |                  \
   ProviderAdapter: AGY   ProviderAdapter: OpenCode   Future provider
   transcript + hooks     session API + events
              \                |                  /
                    bounded resume packet
                               |
              verified same-session resume?
                    yes /             \ no
            resume native        new session with
            session ID           explicit lineage
                               |
                  work + tests + Git verification
                               |
               checkpoint delta + event reconciliation
                               |
           approved verified facts -> memU/Postgres
```

**No direct copying of raw SQLite databases or `.pb` files between machines.** Recovery should still function when native session restore fails.

## ProviderAdapter interface sketch (design only)

```ts
type Provider = "antigravity" | "opencode" | string;
type SessionRef = {
  provider: Provider;
  runnerId: string;           // authenticated, configured runner
  machineId: string;          // durable host identity; not hostname alone
  providerSessionId: string;  // exact ID reported by provider
  workspaceId: string;        // stable repository/project mapping
  repository: string;         // canonical owner/name or validated local root
  model?: string;
};
type ProviderAdapter = {
  capabilities(): Promise<{
    enumerateSessions: boolean;
    readTranscript: boolean;
    resumeNativeSession: boolean;
    observeCompaction: boolean;
  }>;
  discoverSession(ref: SessionRef): Promise<{
    exists: boolean;
    providerState: "idle" | "busy" | "unknown";
    lastMessageId?: string;
    contextUsedTokens?: number;
    contextLimitTokens?: number;
    lastObservedAt: string;
  }>;
  captureReadOnly(ref: SessionRef, cursor?: string): Promise<{
    cursor: string;
    verifiedMessageIds: string[];
    hash: string;
    sanitizedExcerpt?: string;
  }>;
  resumeVerified(ref: SessionRef, instruction: string, idempotencyKey: string):
    Promise<{ providerSessionId: string; accepted: boolean; verified: boolean }>;
};
```

Implement adapters without importing UI-extension state or assuming one provider's session ID is meaningful to another. A session `ref` must include provider, runner and workspace scope. An API request accepted is **not** proof of resumed execution.

## Durable checkpoint contract (merged baseline and proposed extensions)

Each issue-scoped checkpoint should include:
- `schemaVersion`, `revision`, `repository`, `issueId`, `jobKey`/idempotency key, `agentProvider`, `runnerId`, `machineId`, `workspaceId`.
- `nativeSessionRef` and provider message cursor (opaque, version-specific); `lineage` for prior/child sessions and fallback reason.
- `state`, `lastVerifiedGitHead`, `branch`, `prNumber`, `lastObservedReviewSha`, `tests` (command, result, machine, timestamp, commit), `lastVerifiedResult`, `blockers`, `nextAction`, `expiresAt`.
- `lastSyncedEventId`, `lastObservedAt`, `checkpointSource`, `checkpointEvidence`, `sensitivity`, `updatedAt`.

**Current implementation baseline:** PR #31 is merged into `main`, with `schemaVersion: 2`, revisions, `read/update/progress/recoveryPreamble`, redaction, fail-closed cross-process locking, expiry suppression and ordered AGY milestones. The current checkpoint key is `(repositoryRoot, issueId)`, **not** the proposed multi-tenant/session schema. The separate `job-store.mjs` remains operational authority. PR #36 is **closed unmerged** because its lock reclamation implementation remained unsafe. Do not import its directory rename/heartbeat logic. Any new `SessionRef`, runner ownership or event journal needs explicit migration and tests.

**Critical:** “agent says done” is not verified CI success. Preserve current shape, identity, state transitions and tests when adding proposed fields.

Write workflow: idempotent event receipt -> verify job/issue scope -> update checkpoint via atomic CAS/transaction -> acknowledge. Event consumer may retry; operation must never be applied twice. A checkpoint must not contain arbitrary raw credentials, shell history, full transcripts, or untrusted commands interpreted as instructions.

## Bounded resume packet, never whole transcript

Each recovery request should be generated from latest verified Linear issue, GitHub PR/head/reviews/CI, repository status, operational checkpoint and *selected* provider transcript evidence. Proposed sections:
1. Identity: project, issue, provider, runner, repo, current validated workspace, parent/native session.
2. Objective + constraints: most recent authorized requirement, environment limitations, deployment gates.
3. Verified progress: commit SHA, files touched, test commands/results (with timestamps/provenance).
4. Current state: pending/active/waiting-review/needs-recovery/finished; recent blockers.
5. Next authorized action, expiry and reason. On expiry, omit old action *text* and require fresh authority.
6. Pointers: short file paths, source citations or hash references to read if necessary.

Resume packet should be a **small context budget** relative to the available model window, rather than pasting the entire issue or an all-time “brain”. For a model configured at ~16k tokens, **initial experiment**: target ~700-1,200 tokens for the packet, ~1,000-2,000 for recent exact working context, and reserve substantial room for tool results, system instructions and the model response. These are experimental budgets, not proven settings. Measure actual provider-side token accounting and adjust. Long tool outputs should remain on disk with indexed references and small verified extracts.

## OpenCode-specific adapter plan

- Discover actual Ubuntu version, `opencode db path`, API endpoint, active model/context limits, provider session IDs and plugin version; **no hardcoded `~/.local/share/opencode` path assumption** because XDG/OPENCODE_DB overrides exist.
- Use authenticated OpenCode session APIs to enumerate session, read active context and observe status. Avoid direct SQLite writes. Native OpenCode `opencode.db` is *provider-owned* durable history, not our task coordinator.
- Use supported plugin events: `session.created`, `session.updated`, `session.idle`, `session.error`, `session.compacted` (version-dependent), and `experimental.session.compacting` for injecting a **compact, trusted recovery summary** into compaction. Event streams are volatile; regularly reconcile via API/bridge ledger after restart.
- **Checkpoint before compaction or risky tool execution:** persist objective/decision/progress at safe tool/event boundaries. `experimental.session.compacting` can enrich the provider's lossy summary but **must not be the only durable checkpoint**.
- For small local Qwen/Ollama contexts, inspect the actual fixed system/tool footprint first. OpenCode's official V2 default `keep.tokens=15000` is not a fit for a purported 16384-token run if significant instructions/tools must also fit. Test smaller recent-tail budgets and buffer relative to *measured* prompt cost. Do not extrapolate an example model window to the deployed model automatically.
- Check native compact behavior in the pinned Ubuntu OpenCode build. Experimental hooks and background compaction change across versions. Prefer conservative foreground compaction and explicit checkpoints first.
- OpenCode supports sessions in persistent storage even after old messages leave model context; if the provider session is valid, resume it by verified session ID. Otherwise fork/new with lineage and bounded resume packet.

## Antigravity-specific adapter plan

- Prefer explicit native conversation ID emitted by `run_agent.py`; verify the existing `--conversation` resume path and workspaces using the actual job records.
- When supported, use official Antigravity lifecycle hook inputs (`conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`) to discover *read-only* transcripts. Cross-check provided paths are underneath an approved data root before opening them.
- Use Brain Hub `SessionScanner` as an implementation reference for JSONL and artifact parsing; use Antigravity Sync as a *research reference only* for `.pb` portability.
- Never infer a session belongs to an issue by title, workspace path alone or last-used conversation; preserve explicit job-key mapping and actual provider identity.
- Exited/quota exhausted conversations get a durable recovery state, not a UI-auto-click retry. If moving to a new machine/provider, create new lineage and inject verified context rather than overwriting native app data.

## Durable sync/reconciliation contract

**Sync across agents** means synchronized *task progress*, not “two agents share one live conversation database”. For each provider event:
- Record dedupe ID and evidence, advance a monotonic per-session cursor or version, and append scoped checkpoint changes.
- On a reconnect/restart, compare last applied cursor to provider session API history and Git/Linear state; replay missing changes without replaying side effects.
- If the same issue is active on two runners, enforce an explicit lease/owner or hold conflicting writers for review; no hidden “last write wins.”
- Maintain machine ownership. Ubuntu/OpenCode code work cannot mutate Mac LaunchAgent state, and Mac-native conversations aren't a portable session format by default.
- A missed webhook or event-bus message must be recoverable through polling/reconciliation. Avoid echoing every routine event into ChatGPT.

## Failure rules and tests
| Failure | Expected outcome |
| --- | --- |
| Context overflow | provider compacts; bridge checkpoint remains independently readable; model receives bounded summary |
| App crash mid-tool call | job goes interrupted/needs-recovery until side effects reverified; no automatic duplicate action |
| Native session missing | new provider session with explicit parent lineage and verified objective; never claim same-session resume |
| Event stream disconnected | reconcile durable session and job state; do not assume continuous event delivery |
| 16k context with huge tool schema | detect fixed overhead; reject over-budget packet or slim tools; compaction alone cannot fix |
| Two agents same issue | owner/lease rules prevent competing execution; preserve both logs for audit |
| Corrupted transcript or wrong path | quarantine artifact, do not lose operational checkpoint; never escape approved path |
| Secrets in snippets/exports | deny storage or redact according to typed rules and test actual persisted bytes |
| memU/DB outage | continue with local operational checkpoint and live sources; queue verified long-term promotion |
| Old task action expired | suppress text and refresh Linear/GitHub/repo before proposing new action |

## Phase-1 handoff and authority boundary

**Phase 1 delivers research and API/test proposals only**, not an observed native session restore. The authoritative storage and migration design lives in [the merged memory architecture](../../AGENT_MEMORY_ARCHITECTURE.md); existing checkpoint behavior is in [the merged backend notes](../../AGENT_MEMORY_BACKENDS.md). This document owns provider session capability discovery and bounded recovery, not a second database coordinator or review outbox.

Phase 2 first records sanitized **Ubuntu OpenCode** and **AGY** host capabilities from the actual installed binaries, including runner identity, version, authenticated API/hook availability, verified session IDs, read-only samples, and failure cases. Missing features must be reported as `unsupported`, with explicit child-session lineage rather than guessed paths or claims from another machine.

Provider APIs must distinguish `accepted` from `verified`, and session IDs are not authorization tokens. Recovery packets are assembled from refreshed Linear/GitHub/checkout evidence plus exact-key checkpoint data. Provider transcripts and memU remain untrusted evidence, not executable instructions.

## Open decisions for Phase 2
1. Is one active writer per issue sufficient, or do cross-host active-active writers require PostgreSQL transactions?
2. Can current installed OpenCode on Ubuntu expose authenticated session APIs and reliably emit compaction/plugin events?
3. Which contexts justify a native same-session restore vs a new-session recovery packet?
4. Which artifact categories may be stored verbatim? For how long and under whose encryption key?
5. How do we provision a *single* latest checkpoint for each issue across Mac+Ubuntu without routing all traffic through a new availability dependency?

These are **decisions to validate**, not assumptions about current production behavior.
