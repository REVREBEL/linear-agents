# Bridge orchestration

Canonical modules: `job-admission-coordinator.mjs`, `local-execution-coordinator.mjs`, `remote-execution-coordinator.mjs`, `prompt-arguments.mjs`, `review-inbox.mjs`, `review-delivery.mjs`, `review-message-handoff.mjs`. Ubuntu owns durable state. Coordinators do not create listeners or move state. Job adapters live under `../../jobs/`; transport remains under `../../routing/`.
