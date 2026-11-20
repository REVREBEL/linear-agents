# ABR-87 (E3) — Agent Context memory isolation and non-promotion

**Source-level acceptance:** Reading a Git/host README through Agent Context never becomes an agent checkpoint, a memU session, or an instruction to promote long-term memory. Short-term PostgreSQL checkpoint scopes remain independent by tenant, agent, repository and Linear issue. The optional memU **recall** boundary rejects mismatched and unattributed results instead of treating a cross-project semantic match as usable memory.

## Existing storage contracts and their limits

| Mechanism | Isolation key | Current authority / limitation |
| --- | --- | --- |
| Operational filesystem `active-task-memory` | Repository root + issue | One active issue checkpoint, recording `lastAgent` and `lastJobKey`. **Not independently partitioned per agent**. A later agent can supersede the active issue record; it must verify the job/ledger, not treat a prior agent's checkpoint as permission. |
| Experimental `createPostgresCheckpointStore(db)` | Tenant + agent + repository + issue | SQL SELECT/CAS keys all four columns. Each scope has its own revision. Caller-injected adapter is **not connected to live jobs**, and caller input still requires independent authenticated scope binding, DB privileges and production rollout review. |
| Optional `retrieveMemuMemory` | Required tenant + agent + repository + issue on the calling side | The current memU 0.10 `retrieve` CLI takes a free-text query and exposes **no authoritative structured scope switch**. The Bridge adapter therefore requires complete caller scope and only returns hits explicitly carrying matching `scope` / `metadata.scope` keys. Unattributed or mismatched hits produce empty recall. This is defense-in-depth filtering, **not storage isolation, trusted identity verification or database row security**. |
| memU promotion | Genuine canonical session + independently checked same-head review/test evidence | `scripts/memu-promote.mjs` only prepares a verified session for a separate human-controlled evolve executor; it **never commits**. A Context JSON bundle, README or research YAML has no canonical session/evidence and cannot initiate preparation or commit. |

## What changes at E3

The `jobs/preparation/local-task-preparation.mjs` caller now forwards the concrete `agent`, `route.repositoryRoot`, Linear `issueId`, and `job.organizationId` as recall scope. When any identifier is missing, the optional memU retrieval **fails closed before spawning a subprocess**. Existing `MEMU_RETRIEVAL_ENABLED=false` remains the default. Even if enabled, any filtered recall stays **withheld from the agent prompt**. No fallback to another agent, repository or issue is allowed.

`compactRecall` retains its old unscoped utility formatting for non-retrieval consumers and compatibility tests; the **active retrieval** path always supplies validated four-part scope. The memU CLI is still invoked via its existing read-only `retrieve` command, never `memorize prepare`, evolve, commit, or a shell.

## Proof and reproducibility

Run from a reviewed checkout with Node 26 and Python 3:

`node --test memory/context-memory-isolation.test.mjs memory/memu-memory.test.mjs memory/postgres-checkpoint-store.test.mjs linear-agent-bridge/memu-memory.test.mjs`

The E3 suite checks independently persisted PostgreSQL snapshots across distinct tenants, agents, repositories and issues (including restart and stale revisions); missing/malformed recall scopes without any memU process spawn; strict matching across adversarial foreign-agent, repository, issue and tenant results; forwarding a verified job identity during task preparation; and reading README context with `MEMU_RETRIEVAL_ENABLED=true` plus an instrumented fake memU executable **without ever invoking it**. A README-only context bundle also fails the existing canonical memU promotion validator. All fixtures are disposable; no private runtime files or production DB are read or changed.

The Agent Context Blueprint workflow runs this source-level isolation suite together with the existing memU/SQL contract tests. This complements E2 pinned-source handoff acceptance, not a background memory promotion pipeline.

## Deferred runtime verification

- The operational filesystem checkpoint store still uses repository + issue, not independently addressable per-agent files. Do not label its records agent-isolated. The experimental four-key SQL store is the separately scoped prototype, **not a live replacement**.
- memU itself has no authenticated per-agent query restriction in the current CLI interface. A structured tagged result can be filtered, but a malicious/incorrect tag cannot serve as trustworthy authorization. A real per-scope storage/index policy, authenticated namespace source, and multi-agent persistence canary remain separate runtime work.
- Neither README retrieval nor memU recall writes long-term memory. Explicit promotion of independently verified genuine sessions remains a separate, reviewed process. No service restart, OAuth, database migration, production deploy or `/opt` installation occurs in E3.
