# Durable job state

`job-store.mjs` owns the atomic filesystem-backed ledger and restart reconciliation. The live `JOBS_DIR` is intentionally still derived from the systemd-compatible `linear-agent-bridge/agent-bridge.mjs` source location; moving that directory is a separate planned supervised operation.

## ABR-17 M1 submission effect journal

`submission-outbox.mjs` stores durable SQLite submission stages and pending intents under the existing job-state directory on the authoritative Bridge. The database is mode 0600 and uses serialized transactional issue ownership and per-head uniqueness. It does not claim jobs, alter their lifecycle, or authorize a session. Ambiguous effects retain their pending intent; reconciliation requires independently verified observations, never automatic replay.

## ABR-17 M5 — Exclusive authority lease

`submission-exclusive-lease.mjs` holds a SQLite exclusive transaction on a private file in canonical job-state for the managed runtime or offline recovery lifetime. A second connection fails closed and OS lock is released on crash. The lease is not a job-state authority or publication outbox.
