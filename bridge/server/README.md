# Canonical bridge server

`agent-bridge-runtime.mjs` owns the HTTP listener, `/jobs` authorization, server startup, agent runtime wiring and the job root anchored to the original loader location. `http-helpers.mjs` owns protocol utilities; `http-route-composition.mjs` owns non-job ingress order.

The stable systemd/LaunchAgent path `linear-agent-bridge/agent-bridge.mjs` is a thin import-only loader. The canonical runtime explicitly derives `PROJECT_DIR` from that loader's location so `linear-jobs/`, routing files and CLI agent scripts are not relocated. No duplicate server listener or state authority is permitted.
