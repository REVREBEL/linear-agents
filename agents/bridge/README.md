# Bridge-owned agents

`event-intelligence/` classifies and routes actionable signals. `reviewer/worker/` is the distinct ChatGPT reviewer identity. Coding identities and their worker packages live under `agents/coding/`. Preserve their OAuth, KV, callback, and job-state boundaries during reorganizations.


ABR-18 Phase 1 runtime utilities live in `integrations/event-intelligence.mjs`.
The existing `event-intelligence/event-intelligence-agent.ts` is a research
prototype, not a wired model-inference or reviewer-dispatch runtime. The
separate `reviewer/worker/` identity continues to own authenticated
ChatGPT review notifications, and no-prompt Linear capture is planned
for the next review-gated phase.
