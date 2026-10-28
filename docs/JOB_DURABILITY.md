# Durable local job ledger

## Quota recovery and inbox lifecycle (source-verified 2026-10-28)

In addition to the states below, the bridge implements **`waiting_quota`** for Antigravity structured quota exhaustion. On detecting the exhaustion event with a usable `conversation_id`, it persists `conversationId`, `resumeAt`, `resumeAttempts` and task/workspace metadata in the ledger. `AGY_RETRY_DELAY_MS` defaults to **7,200,000 ms (two hours)** and is clamped to at least 60 seconds. The runner resumes via the recorded conversation ID (the AGY CLI `--conversation <id>` path). The retry mechanism limits scheduled recovery attempts to **three**, failing the job if the limit is reached or conversation identity is missing. On restart, the bridge reloads `waiting_quota` records and schedules remaining retries. This is an implemented path, **not** proof of recovery observed under actual production quota exhaustion.

The ordinary restart reconciliation converts uncertain `received`, `queued`, `launching`, and `running` jobs to `interrupted` without replaying their side effects. `waiting_quota` is intentionally distinct from those states. Source details: `linear-agent-bridge/agent-bridge.mjs` and `linear-agent-bridge/job-store.mjs`.

Compact task JSON contains the direct task `payload.data.promptContext`; it should not carry raw duplicate payloads or embedded completion curl instructions. Session completion via Worker `/complete` and the Linear issue's workflow status are separate. Inbox JSON under the project-scoped `.linear-agent/projects/<project-uuid>/inbox/` is retained until the Worker reports the associated Linear issue has transitioned to a **completed** workflow status and the bridge handles authenticated `POST /issue-completed`. A failed session remains available for investigation. Removing an inbox file does not by itself remove ledger history.

---


This bridge uses a small filesystem-backed lifecycle ledger inspired by durable orchestration patterns (idempotent delivery, explicit states, crash reconciliation). It does **not** embed or depend on Trigger.dev.

## Location and identity

State files live in `linear-agent-bridge/linear-jobs/job-state/<sha256(agent:delivery-id)>/state.json`. Delivery IDs come from `x-linear-webhook-id`; absent that header, the bridge hashes the raw job body for stable deduplication. Keys are scoped by agent. These are runtime files and must remain untracked.

The bridge claims a delivery with atomic directory creation before routing or executing it. Repeated deliveries receive `202` with `duplicate: true` and the last state; they do **not** launch a second agent. A duplicate response after a prior failed/unrouted job is still an acknowledgment of the original claim, not proof of successful execution.

## States

- `received`: delivery identity reserved; may not have reached durable task-file storage
- `unrouted`: routing failed; payload saved for investigation
- `queued`: routed job JSON saved to the repository's existing local inbox
- `launching`: dispatch started
- `running`: child process emitted `spawn`
- `completed`: tracked headless child process exited with status zero
- `failed`: configuration, child launch, or tracked process failed
- `awaiting_external`: dispatched to an external UI (ChatGPT save-only or Gemini Warp opener); completion cannot be independently verified
- `interrupted`: bridge restarted after a `received`, `queued`, `launching`, or `running` job

On startup the bridge conservatively marks uncertain jobs interrupted. **It never automatically relaunches them.** A command may have already written code or made Linear updates before the crash. Inspect the task and its repository before manually retrying. A deliberate retry needs a new delivery/attempt identity or an explicit future recovery workflow; simply replaying the same delivery will deduplicate.

The ledger is local durability, not a remote queue: webhook deliveries cannot be received while the Mac is offline. Cloudflare Queues or another upstream retry mechanism would be a separate enhancement. All data may be lost if the Mac's disk fails. The state file is persisted via temp-file rename but is not a transaction across task files and agent processes.

## Operational notes

- Test the module with `node --test linear-agent-bridge/job-store.test.mjs`.
- The bridge logs the count of interrupted records during startup. Inspect records under `linear-agent-bridge/linear-jobs/job-state/`.
- Headless processes are marked completed by exit status; a zero exit is **not** proof the code changes are correct or that Linear was updated.
- Gemini Warp is marked awaiting external because the tracked process is only macOS `open`, not the Gemini CLI.
- Deploy and restart during idle periods. Until automatic reconciliation is implemented, unfinished jobs require manual review.

## Worker-side acceptance hardening (2026-10-28)

All five Workers now authenticate the Linear installation before consulting their webhook deduplication marker. For actionable agent sessions, they await the bridge's HTTP acknowledgment before writing `webhook:<organization>:<delivery>` with a one-day TTL. Failed authentication, failed forwarding, and failed issue-completed cleanup no longer preemptively write a successful-delivery marker. When Linear does not supply `linear-delivery`, a SHA-256 fingerprint of the signed payload body is used rather than the webhook configuration ID (`payload.webhookId`). A successful bridge `202` can mean a previously persisted local duplicate, which is acceptable for a retry.

**Concurrency and deployment limitations:** Cloudflare KV does not provide atomic compare-and-set or strongly consistent reads. Simultaneous identical events may both pass the marker check, making local bridge idempotency the final safeguard. This change does not implement Durable Objects, Cloudflare Queues, an OAuth refresh lock, or durable retry scheduling at the Worker edge. Agent Activity creation before forwarding can be repeated when Linear retries. Live OAuth/Cloudflare webhook testing is still required. Do not characterize this as exactly-once processing. A future production-grade ingress should use an atomic durable claim with explicitly retryable and accepted states.
