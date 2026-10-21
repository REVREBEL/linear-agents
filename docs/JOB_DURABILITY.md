# Durable local job ledger

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
