# Bridge orchestration

Canonical modules: `job-admission-coordinator.mjs`, `local-execution-coordinator.mjs`, `remote-execution-coordinator.mjs`, `prompt-arguments.mjs`, `review-inbox.mjs`, `review-delivery.mjs`, `review-message-handoff.mjs`. Ubuntu owns durable state. Coordinators do not create listeners or move state. Job adapters live under `../../jobs/`; transport remains under `../../routing/`.

## ABR-99 — MCP progress and review integration boundary

`mcp-milestone-integration.mjs` is a library binding server-verified Linear job/session/tenant/repository/issue/host/branch to the **existing** ledger, file-locked checkpoint and durable ChatGPT user review inbox. Interactive tools and lower-trust output cannot mint handles or update the task. The adapter adds per-tool replay prevention, bounded redacted milestone/recovery context, optional canonical D5 full handoff verification and a **disabled-until-injected** ABR-17 `submitWork` path. The only approved review queue is `review-inbox.mjs`; enqueue is not delivery/ACK. No new CLI or live HTTP ingress is installed. [ABR-99 source and negative tests](../../docs/audits/mcp/BRIDGE_INTEGRATION.md).

PR #262 review fixes: the D5 adapter snapshots and recursively freezes the same bounded JSON envelope before asynchronous verification and returns only that snapshot. Tool summaries are normalized to the exact bounded form preserved by the canonical checkpoint sanitizer; truncation never splits a redaction marker or causes an identical receipt retry to increment the checkpoint revision.

## ABR-17 M1 — Submission coordinator

`submission-coordinator.mjs` enforces trusted coding-job binding, confirmed issue and sanitized summary, exact pre-pushed Git/CI evidence, one issue owner and one PR across revisions, and durable before-effect intents through the job-state submission outbox. It requires explicitly injected trusted publication/Linear/review/Worker adapters and refuses ambiguous retries until verified reconciliation. Disabled by default and not imported by the runtime. See [contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).
