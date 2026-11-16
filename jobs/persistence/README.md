# Durable job state

`job-store.mjs` owns the atomic filesystem-backed ledger and restart reconciliation. The live `JOBS_DIR` is intentionally still derived from the systemd-compatible `linear-agent-bridge/agent-bridge.mjs` source location; moving that directory is a separate planned supervised operation.
