# Canonical bridge server

`agent-bridge-runtime.mjs` owns the HTTP listener, `/jobs` authorization, server startup, agent runtime wiring and the job root anchored to the original loader location. `http-helpers.mjs` owns protocol utilities; `http-route-composition.mjs` owns non-job ingress order.

The stable systemd/LaunchAgent path `linear-agent-bridge/agent-bridge.mjs` is a thin import-only loader. The canonical runtime explicitly derives `PROJECT_DIR` from that loader's location so `linear-jobs/`, routing files and CLI agent scripts are not relocated. No duplicate server listener or state authority is permitted.

## Local-only MCP relay design exercise (ABR-94)

`mcp-relay/index.mjs` is a test-only, independently authored, authenticated **localhost listener**, paired with a read-only host WebSocket fixture. It is not imported by `agent-bridge-runtime.mjs`, registered under `/jobs`, exposed through Cloudflare, or installed by systemd. The [relay README](mcp-relay/README.md) and [source audit](../../docs/audits/mcp/README.md) establish strict tool restrictions and future ABR-95 OAuth/transport ownership. `jobs/persistence/job-store.mjs` stays the sole Linear task ledger.
