# HTTP server contracts

`http-helpers.mjs` implements hostname/body/response primitives. `http-route-composition.mjs` composes the existing non-job HTTP handlers. The established `linear-agent-bridge/agent-bridge.mjs` still owns the listener, `/jobs` authentication and admission, 404/500 handling, and persisted runtime job directory. No second HTTP listener or state authority is permitted here.
