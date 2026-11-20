# Task preparation

`local-task-preparation.mjs` writes canonical repository-scoped task files and checkpoints before any local agent launch. It preserves the established private filesystem root and the queued transition ordering.


## ABR-59 M2 deterministic recall query

Before requesting optional recall, local task preparation now derives a bounded query solely from the trusted route repository root, resolved issue ID, and the fixed `coding` task kind. Malformed route fields skip recall. Raw issue descriptions, session transcripts, README bodies and MCP tool output cannot change the query. The returned text remains **withheld from the prompt**. See [M2 scope and provenance contract](../../docs/ABR59_SCOPED_RECALL.md).

## E3 memU read scope (ABR-87)

The optional, disabled-by-default long-term **recall** request passes `job.organizationId`, the selected local agent, `route.repositoryRoot`, and the resolved Linear issue ID as a four-field scope. The adapter rejects missing identifiers and untagged or foreign-scoped memU results; its output remains excluded from the agent's prompt. The installed memU CLI does not provide a trusted structured scope filter, and this caller metadata is not a substitute for DB/namespace authorization. See [Agent Context E3](../../docs/blueprints/agent-context/MEMORY_ISOLATION.md) and `memory/context-memory-isolation.test.mjs`.

## ABR-91 Factory Brain reference injection

At local admission, an independently operator-approved private Factory Brain file may supply at most 2,400 characters of bounded, lower-trust reference data. It is scoped to the exact tenant, agent and canonical repository and included only when the source SHA256 matches `FACTORY_BRAIN_APPROVALS_JSON`. An absent/stale/unapproved file is omitted without blocking the job. No backend write or promotion is performed. See [ABR-91 contract](../../docs/ABR91_FACTORY_BRAIN.md).

## Scoped checkpoint recovery (ABR-90 M1)

Local admission injects bounded, non-authoritative checkpoint context only when tenant, agent, repository and issue match. Ownership changes or expired checkpoints clear prior session-derived state before fresh progress is recorded. Revision checks prevent adopting a concurrently modified checkpoint; this does not provide independent per-agent storage isolation.
