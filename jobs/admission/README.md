# Job admission

`job-admission.mjs`, `job-preflight.mjs`, `unrouted-delivery.mjs` implement delivery identity, preflight and safe duplicate/recovery rules. Admission coordination lives at `../../bridge/orchestration/job-admission-coordinator.mjs` and must precede side effects.

## ABR-17 M4 — Managed delivery admission

Managed coding admission requires an approved local route and skips workspace Linear credential synchronization. The canonical claim records managed mode, and duplicate delivery is not acknowledged as accepted until a durable managed launch marker exists. Invalid managed routes never fall through to legacy remote dispatch.
