# HTTP server composition

Canonical non-job HTTP route composition lives here. The production listener and `/jobs` authorization remain in `linear-agent-bridge/agent-bridge.mjs` until an explicitly tested entrypoint cutover. Do not create another server listener or relocate persisted state.
