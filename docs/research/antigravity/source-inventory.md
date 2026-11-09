# ABR-11 | Source inventory: Antigravity, OpenCode, and the Linear Bridge

**Status:** reviewed source inventory, updated 2026-11-09. No production host inspected or changed. The pinned 2026-11-07 bridge baseline is historical; verify merged implementations against current `main`.  
**Linear:** [ABR-11](https://linear.app/revrebel/issue/ABR-11) (Phase 1); related [ABR-3](https://linear.app/revrebel/issue/ABR-3) (checkpoint implementation) and [ABR-1](https://linear.app/revrebel/issue/ABR-1) (routing).  
**Goal:** inventory reusable session-discovery, context-compaction, recovery and state-transfer mechanisms across providers; **not** implement raw session synchronization as a substitute for durable task state.

## Pinned source versions
| Repository | Revision examined | Role |
| --- | --- | --- |
| [chiriforge/brain-hub-antigravity](https://github.com/chiriforge/brain-hub-antigravity/tree/978b5c629896fce60edb6ac04effbdf85ebbd8b2) | `978b5c629896fce60edb6ac04effbdf85ebbd8b2` | Brain transcript discovery, UI, archive and sync |
| [mrd9999/antigravity-sync](https://github.com/mrd9999/antigravity-sync/tree/938b24c5c04918bb49bd2fe67c1251cfb56df2d5) | `938b24c5c04918bb49bd2fe67c1251cfb56df2d5` | Native data synchronization and retry automation |
| [anomalyco/opencode](https://github.com/anomalyco/opencode/tree/c33eaa170ed5093c08f1684862a695aae036dcda) | `c33eaa170ed5093c08f1684862a695aae036dcda` | OpenCode canonical repository; API/docs are evolving |
| [REVREBEL/linear-agents](https://github.com/REVREBEL/linear-agents/tree/81e253ff9d2637aa1108d9de6ea448391649b140) | `81e253ff9d2637aa1108d9de6ea448391649b140` (main research baseline) | Existing bridge contracts. Historical pre-#31 snapshot; **#31 and #32 are merged, and #36 is closed unmerged**. This baseline is not the current implementation. |

All third-party components require license/attribution review before reuse; repository badges/descriptions are not a substitute for checking committed LICENSE files.

## Current bridge, authoritative boundaries
| Source | Function supported in baseline | What must remain authoritative |
| --- | --- | --- |
| [job-store.mjs](../../linear-agent-bridge/job-store.mjs) | Claims and transitions job state; startup interruption reconciliation; issue/session queries | Job execution and callback ledger |
| [active-task-memory.mjs](../../linear-agent-bridge/active-task-memory.mjs) | Per repo+issue durable recovery checkpoint | Bounded operational state, not inferred long-term facts |
| [github-task-memory.mjs](../../linear-agent-bridge/github-task-memory.mjs) | PR event digest and review checkpoint | GitHub event delivery and review notification state |
| [agy-conversation-state.mjs](../../linear-agent-bridge/agy-conversation-state.mjs) | Explicit AGY resume intent bookkeeping | Provider conversation identity, distinct from job success |
| [run_agent.py](../../linear-agent-bridge/run_agent.py) | AGY runner, explicit `--conversation`, streamed conversation ID and quota-exhaustion event | AGY runtime identity and observed completion, not tests verified by exit code |
| [AGENT_MEMORY_REVIEW_LOOP.md](../../AGENT_MEMORY_REVIEW_LOOP.md) | Defines four distinct states and current limitations | Existing bridge design rules |

**Current target-main distinction (2026-11-09):** merged [#31](https://github.com/REVREBEL/linear-agents/pull/31) added versioned/revisioned checkpoints, redaction, fail-closed cross-process locking, ordered AGY tool milestones and bounded last-six recovery summaries; optional memU retrieval is **withheld from coding-agent prompts** and verified promotion is only a prepare adapter. Merged [#32](https://github.com/REVREBEL/linear-agents/pull/32) is the authoritative architecture. [#36](https://github.com/REVREBEL/linear-agents/pull/36) was closed unmerged because its unsafe lock-reclamation branch is superseded. **Still missing:** provider-neutral native-session inventory/adapter, cross-provider resume, authenticated OpenCode API verification, live PostgreSQL cutover, reliable cross-machine checkpoint ownership and complete memU promotion execution. These documents do not change the live runtime.

## Brain Hub source map (Antigravity)
| Source | Supported behavior | Reuse direction |
| --- | --- | --- |
| [SessionScanner.ts](https://github.com/chiriforge/brain-hub-antigravity/blob/978b5c629896fce60edb6ac04effbdf85ebbd8b2/src/services/SessionScanner.ts) | Multiple user/configured `brain/` roots; locates `.system_generated/logs/transcript.jsonl` and optional `transcript_full.jsonl`; extracts session/threads; persistent cache, lock, watchers | **Adapt discovery/parsing concept** behind read-only, bounded parser, not a wholesale extension dependency |
| [GitSyncService.ts](https://github.com/chiriforge/brain-hub-antigravity/blob/978b5c629896fce60edb6ac04effbdf85ebbd8b2/src/services/GitSyncService.ts) | Git inside `brain/`, background sync, `git add .`, pull merge `-X ours`, and local cross-window guards | **Reject raw bidirectional sync** for active task authority; avoid silent conflict preference |
| [SecretSanitizer.ts](https://github.com/chiriforge/brain-hub-antigravity/blob/978b5c629896fce60edb6ac04effbdf85ebbd8b2/src/services/SecretSanitizer.ts) | Regex/string recursive credential masking for exports | **Adapt test patterns**, not assume arbitrary secrets can always be redacted |
| [ProjectDocsArchiver.ts](https://github.com/chiriforge/brain-hub-antigravity/blob/978b5c629896fce60edb6ac04effbdf85ebbd8b2/src/services/ProjectDocsArchiver.ts) | Workspace-scoped plan/walkthrough/transcript export and optional `.gitignore` protections | **Adapt manifest/provenance and export classification**, with opt-in sanitized output |
| Test fixtures | `test/test_session_scanner_concurrency.js`, `test/test_atomic_cache_persistence.js`, `test/test_git_sync_resilience.js`, `test/test_sanitizers_resilience.js` | Port behavioral cases, not library runtime |

**Important distinction:** a Brain Hub “resume prompt” refers to historical session content in a new chat; it does not prove native provider session restoration.

## Antigravity Sync source map
| Source | Supported behavior | Reuse direction |
| --- | --- | --- |
| [FilterService.ts](https://github.com/mrd9999/antigravity-sync/blob/938b24c5c04918bb49bd2fe67c1251cfb56df2d5/src/services/FilterService.ts) | Include/exclude rules for selected Gemini directories | Adapt allowlist and exclusions; require identical validation on restore |
| [SyncService.ts](https://github.com/mrd9999/antigravity-sync/blob/938b24c5c04918bb49bd2fe67c1251cfb56df2d5/src/services/SyncService.ts) | Filtered outgoing sync, Git transport and recursive restore | **Reject default restore path**: copying repo contents back bypasses equivalent incoming validation |
| [GitService.ts](https://github.com/mrd9999/antigravity-sync/blob/938b24c5c04918bb49bd2fe67c1251cfb56df2d5/src/services/GitService.ts) | Git repository and transport operations | Concept only; not canonical multi-writer agent state |
| [AutoRetryService.ts](https://github.com/mrd9999/antigravity-sync/blob/938b24c5c04918bb49bd2fe67c1251cfb56df2d5/src/services/AutoRetryService.ts) / [CDPHandler.ts](https://github.com/mrd9999/antigravity-sync/blob/938b24c5c04918bb49bd2fe67c1251cfb56df2d5/src/services/CDPHandler.ts) | CDP injection; detects and clicks UI “Retry” within error contexts | **Do not adopt automatic clicks**. Observe and classify errors; authorized retry belongs to bridge scheduler |
| ConfigService, WatcherService | Extension config and sync monitoring | Inform discovery and change detection only |

README documents workspace-absolute-path dependency for visibility of copied conversation records. This is a **portability warning**, not evidence of successful session continuation on Linux/Mac. Also distinguish `.pb` conversation stores from `brain/` JSONL transcript stores: different representations with different ownership/restore semantics.

## OpenCode (Ubuntu): source-supported interfaces
- [Official compaction](https://opencode.ai/docs/compaction/): lossy summarization, configurable recent-history keep tokens, buffer, manual compaction, overflow retry. Historical messages can remain stored but not enter active model context.
- [Official plugin documentation](https://docs.opencode.ai/docs/plugins/): project `.opencode/plugins/` and global `~/.config/opencode/plugins/`, event hooks including session lifecycle and `experimental.session.compacting` for adding grounded resume context to compaction summaries.
- [Official API](https://opencode.ai/docs/api): session list/context and compaction operations; event stream. **Event subscriptions are volatile** and must be reconciled against durable session/job state after reconnect.
- [Official troubleshooting/storage](https://docs.opencode.ai/docs/troubleshooting/): `opencode db path`, OpenCode-owned `opencode.db` SQLite plus auth/snapshot directories; **do not read/change `auth.json`**.
- Prefer **authenticated SDK/API read-only session snapshot/export** over direct edits to internal SQLite schema. Do not assume the running Ubuntu OpenCode binary exposes every experimental V2 route. Pin installed version and inspect `opencode --version`, `opencode db path`, API accessibility/port, configured model limits and active session IDs on the actual Ubuntu host before coding.
- Provider compaction and model context are distinct from bridge checkpoint persistence. A model showing 100% context is not equivalent to a missing session on disk.

## Provider capability matrix
| Capability | Antigravity | OpenCode | Provider-neutral bridge |
| --- | --- | --- | --- |
| Read-only session discovery | Brain JSONL and native ID (paths vary) | Session API / SQLite owned by OpenCode | `listSessions`, `getSessionMetadata` |
| Native same-session resume | Provider CLI/session ID; validate actually resumed | Provider session API/CLI; version-specific | `resume(sessionRef)` returns *verified* identity or explicit unsupported |
| Summary or compaction | Provider-defined | Native compaction + plugin hook | External checkpoint saved before/after; cannot trust summary alone |
| Event capture | Runner stream, supported hooks | Event stream and plugin event hooks | At-least-once journal + reconciler |
| Cross-machine native import | **Unproven**; paths/index can differ | **Unproven**; provider-owned DB and session scope | New lineage + synthesized, verified resume brief when native import unavailable |
| Long-term semantic recall | Not supplied by these extensions | Not native bridge memory | memU/pgvector downstream, never gating job completion |

## Source evidence vs lab hypotheses
**Verified from source/docs:** file naming/layout candidates, API surface descriptions, sync/compaction approaches, and bridge state separation.  
**Not yet verified:** real AGY Mac↔Linux native restoration, OpenCode session API version on Ubuntu, whether OpenCode Qwen context is exactly the Ollama-configured 16,384 tokens after all model/provider limits, fidelity of event delivery on restart, plugin hooks firing under local-model failures, memory ingestion latency/accuracy, and ability to resume a live provider session after host failure.

## Security constraints
Never sync `~/.gemini` or `~/.local/share/opencode` recursively. Tokens, provider credentials, browser artifacts and unfiltered raw prompts may live there. Native transcripts are untrusted data. Use read-only provider adapters, scoped export allowlists, secure at-rest encryption/retention, IDs + hashes for provenance and explicit human-gated deployment to production hosts. Do not accidentally overwrite Mac runtime files from Ubuntu. Maintain clear lineage on every fallback.

## Reuse and change-control decision (2026-11-09)

Reuse pinned third-party projects as **research only**. Copy no upstream code without auditing the pinned LICENSE and dependency/license notices. Do not use native provider databases or raw transcripts as the replicated operational record. Implementation against `main` should add independent adapter modules and explicit typed conversion to the existing checkpoint API, not replace `active-task-memory.mjs`, `job-store.mjs` or the GitHub-to-ChatGPT review loop.

The original bridge SHA in the table was a reproducible *research snapshot*, **not** the source of the merged production contract. Before implementing a Phase-2 adapter, record target checkout SHA, active runner host, installed provider binary version, supported API routes and the actual user-authorized data roots in a separate sanitized capability report.
