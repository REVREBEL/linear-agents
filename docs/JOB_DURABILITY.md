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

## P1/P2: SQLite Durable Object ingress and shared reliability layer

**Introduced on PR #12; validate the new binding and alarm behavior before deployment.**

- Every Worker exports a `DeliveryCoordinator` with a SQLite-backed Durable Object binding `DELIVERY_COORDINATOR`. Wrangler provisions this resource the first time the updated Worker is deployed. Each Worker owns its own namespace; the object is keyed by `SERVICE_NAME:organizationId`.
- The Worker verifies the signed request *before* routing it into the coordinator. The coordinator serializes webhook execution per organization. It persists the signed delivery as `pending:<id>` before authentication or bridge dispatch, changes it to `accepted:<id>` only after successful handling, and uses an alarm with exponential backoff (one minute up to two hours) for independent recovery when Linear stops retrying. The bridge's own idempotency ledger continues to prevent double execution.
- Session completion callbacks use the same per-organization coordinator so their OAuth refresh cannot overlap with webhook processing. The shared `oauth-errors.ts` classifies `invalid_grant` as `reauthorization_required`; a reauthorization-required delivery stays pending and can resume after reinstalling the Linear app. It does not automatically reauthorize an expired app.
- `shared/delivery-coordinator.ts` and `shared/oauth-errors.ts` consolidate cross-Worker lifecycle, retry, and OAuth error logic. Per-agent activity handling and routing remain intentionally separate.
- `npm run test:reliability` runs the existing bridge ledger tests plus isolated OAuth and mocked Worker failure-injection tests. `npm run typecheck` checks all five Worker projects. The `Worker Reliability Validation` GitHub Actions workflow runs these checks with dummy credentials; it does not contact production Linear or Cloudflare services.

**Operational boundaries:** DO alarms preserve retry intent, but repeated external side effects can still occur if a process crashes between bridge acceptance and the coordinator commit. Never assume exactly-once execution; the bridge ledger is required. Pending payloads are stored in Cloudflare Durable Object storage and may contain issue instructions. Restrict Cloudflare account access accordingly. The Mock Agent's separate administrative API is not yet routed through the per-organization coordinator. The old KV accepted markers remain as a secondary check; the DO accepted state is authoritative for admission.

**First deployment:** Pull the PR branch, run `npm run types`, `npm run typecheck`, and `npm run test:reliability`. Review the generated Wrangler config before running `npm run deploy -- <agent>`. Each deployment provisions a new SQLite Durable Object namespace. Confirm alarms and delivery acceptance in Worker logs and test an isolated Mock Agent event before rolling out to the other four Workers. Never remove an existing DO namespace to force a redeploy, as that discards pending jobs.

