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
- Antigravity headless sessions pass a session-only permission allowlist for
  `mcp(github/list_commits)`, the read-only discovery call required by the
  Linear issue workflow. Other unapproved MCP or unsandboxed actions remain
  denied; do not replace this with `--dangerously-skip-permissions`.
- The Antigravity runner posts `thought`, `response`, and `error` activities to
  the authenticated Worker completion endpoint. It does not call
  `agentActivityCreate` with a personal Linear API key.
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


### Legacy deduplication migration

Older Workers used `payload.webhookId` as a fallback deduplication identifier when `linear-delivery` was absent. This value can identify the **webhook configuration**, not the individual event; the legacy `webhook:<configurationId>` KV record may therefore have been written for many unrelated deliveries, including ones that never reached the bridge. **Do not migrate or trust that record as proof an individual task was accepted.** New Workers derive a stable SHA-256 from the verified payload instead. For any suspicious pre-upgrade event, compare its Linear session/issue and the local bridge ledger and manually reconcile it rather than automatically replaying potentially completed work. Old legacy KV markers are left intact only for audit and expire on their original TTL.

Linear start activities now have a separate coordinator-stored `activity:<delivery>:started` marker, written after the activity succeeds. Retryable bridge failures cannot repeat that acknowledgement after the marker is persisted; the job stays pending until accepted. A crash between Linear confirming the activity and committing the activity marker may still cause the activity to be posted again, because the Linear mutation does not accept a demonstrated idempotency key in this implementation.

## AGY conversation identity and ledger fields (PR #18)

By default, conversation continuity is scoped to the exact Linear **`agentSessionId`**, not the issue ID. An unassign/reassign cycle creates a different Agent Session and starts a fresh AGY conversation while issue-level recovery is disabled. A `prompted` follow-up uses the matching session and workspace, not an issue-wide fallback. When explicitly enabled, the separate issue-level recovery feature can inherit a previously verified, completed AGY conversation after reassignment, but only for the same issue and resolved workspace, as detailed below.

Relevant ledger fields include `agentSessionId` (session identity), `workspace` (workspace isolation), `conversationId` (verified AGY CLI conversation identifier), `conversationVerifiedAt` (timestamp when the CLI conversation identifier was verified), `resumedConversationId` (identifier selected for an explicit resume), and `conversationSource` (continuation origin, such as `follow_up` or `quota_retry`). The quota state additionally carries `resumeAt` and `resumeAttempts`. These are diagnostic and lifecycle fields; they do not authorize reuse across different Agent Sessions.

The AGY Python runner strips `BRIDGE_SHARED_SECRET`, `LINEAR_API_KEY`, and `LINEAR_ACCESS_TOKEN` from the environment of the spawned `agy` subprocess. The Python parent retains access to the bridge secret where needed for the authenticated completion callback. This is not a claim that all other ambient environment variables are stripped.

**Production validation boundary:** Worker/DO reliability tests and bridge diagnostics do not establish that the Durable Object alarm retry path has been observed under a live delivery outage. Similarly, the implemented two-hour `waiting_quota` continuation has not been observed end-to-end during genuine AGY product quota exhaustion. Track these separately from unit test pass/fail results.

## Optional issue-level AGY recovery (feature branch)

Set `AGY_ISSUE_RECOVERY_ENABLED=true` in the trusted bridge environment to allow a newly assigned Linear Agent Session to reuse a prior AGY conversation for the **same issue and resolved workspace**. Disabled by default. The first choice remains the exact `agentSessionId` for follow-ups; issue recovery is never applied to a prompted follow-up that lacks an existing same-session conversation. Cross-session recovery considers only **completed** AGY ledger records with a real `conversationVerifiedAt` observation, an eligible `conversationId`, and a different `agentSessionId`; interrupted or active jobs do not qualify. Recovery metadata includes `conversationSource: "issue_recovery"`, `recoveredFromAgentSessionId`, `recoveredFromJobKey`, and `resumedConversationId`. Requesting a resume does not itself set `conversationVerifiedAt`.

This recovery depends on retained local ledger records and an AGY conversation still being accessible to the local runner. A legitimate same-issue transfer across a different resolved workspace is deliberately not resumed. Do not enable automatically in production before observing a real reassignment and confirming the underlying AGY CLI accepts the inherited conversation ID.
