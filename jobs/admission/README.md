# Job admission

`job-admission.mjs`, `job-preflight.mjs`, `unrouted-delivery.mjs` implement delivery identity, preflight and safe duplicate/recovery rules. Admission coordination lives at `../../bridge/orchestration/job-admission-coordinator.mjs` and must precede side effects.
