# Task preparation

`local-task-preparation.mjs` writes canonical repository-scoped task files and checkpoints before any local agent launch. It preserves the established private filesystem root and the queued transition ordering.


## E3 memU read scope (ABR-87)

The optional, disabled-by-default long-term **recall** request passes `job.organizationId`, the selected local agent, `route.repositoryRoot`, and the resolved Linear issue ID as a four-field scope. The adapter rejects missing identifiers and untagged or foreign-scoped memU results; its output remains excluded from the agent's prompt. The installed memU CLI does not provide a trusted structured scope filter, and this caller metadata is not a substitute for DB/namespace authorization. See [Agent Context E3](../../docs/blueprints/agent-context/MEMORY_ISOLATION.md) and `memory/context-memory-isolation.test.mjs`.

## Scoped checkpoint recovery (ABR-90 M1)

Local admission injects bounded, non-authoritative checkpoint context only when tenant, agent, repository and issue match. Ownership changes or expired checkpoints clear prior session-derived state before fresh progress is recorded. Revision checks prevent adopting a concurrently modified checkpoint; this does not provide independent per-agent storage isolation.
