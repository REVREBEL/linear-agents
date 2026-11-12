# Antigravity Cloudflare Worker

This Worker receives Linear and GitHub events for the Antigravity coding agent. Source code is colocated under `agents/coding/antigravity/worker/`.

The production-facing identity remains `linear-antigravity-agent`. The custom domains, `ANTIGRAVITY_PREFIX`, `ANTIGRAVITY_KV_NAMESPACE_ID`, `LINEAR_DATA` binding, `DELIVERY_COORDINATOR` Durable Object, OAuth installation, and GitHub webhook signature configuration remain unchanged. This is a source-path-only relocation.

The Worker authenticates and coordinates incoming events and forwards jobs to the configured bridge. Agent CLI execution, session identifiers, resume policy and Mac/Ubuntu host selection remain outside the Worker, governed by existing bridge configuration. No session or job state is moved by this change.

From the repository root:

```bash
npm ci
npm run registry:validate
npm run types -- antigravity
npm run typecheck
npm run test:reliability
```

`agents/registry.json` records the current Worker location. Use `scripts/with-env.sh` and `scripts/render-wrangler.mjs` with an authorized local environment to render temporary Wrangler configuration. Never commit runtime secrets, KV IDs or generated configuration. Production deployment and Ubuntu service restarts require separate approval.
