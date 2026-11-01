# LinearBridge diagnostics

## Commands

```bash
npm run bridge:status
npm run bridge:doctor
```

`bridge:status` remains fast and local. `bridge:doctor` reads the root `.env` using `scripts/bridge.sh`, checks the local router, checks the distinct **Worker custom domains** (`linear-${PREFIX}.${DOMAIN}`), then checks the direct **Tunnel hostnames** (`${PREFIX}-agent.${DOMAIN}`). A unique authenticated probe is sent separately to each Worker and each Tunnel endpoint. Only the Worker response with `stage=bridge`, the matching UUID, and the local bridge service name proves Worker → Tunnel → bridge forwarding.

Each probe requires the existing `BRIDGE_SHARED_SECRET` in an Authorization header, and a UUID in `x-bridge-probe-id`. Neither Worker nor bridge creates jobs, invokes agents, writes to the delivery ledger, or calls Linear for a probe. A response must echo the probe UUID. The CLI fails with a nonzero status when checks fail.

## Deployment and WAF

**The feature does not become available on public endpoints simply by merging this branch.** Deploy the updated five Workers and restart the local bridge first. During the test phase, deploy only to a controlled environment if possible.

Cloudflare WAF rules that currently permit only `/install`, `/oauth/callback`, and `/webhook` will probably block `POST /diagnostics/probe`. Add a **narrow, authenticated probe exception** to the existing route policy, ideally limited to the trusted operator IP or a Cloudflare Access service-token policy. Never permit arbitrary unauthenticated traffic to `/jobs`. This endpoint performs its own shared-secret verification, but WAF/IP restrictions provide important defense in depth.

The public Worker `/health` endpoint tests Worker reachability, **not** the Tunnel. Only the acknowledged probe tests Worker → Tunnel → local bridge connectivity. No synthetic probe tests Linear's real webhook signature generation or the upstream Linear → Worker path; use a controlled Linear issue for that.

## Operational notes

- A 403/404 at the public probe endpoint commonly means WAF policy or a Worker not yet deployed.
- A 502 means the Worker could not obtain a valid acknowledgment from the local bridge.
- A timeout could indicate a Tunnel/origin or network problem; inspect `cloudflared` logs.
- All hostnames must be configured in the local root `.env` or the doctor falls back to the repository's example `*.revrebel.io` hostnames.
- `BRIDGE_SHARED_SECRET` must match the deployed Worker and bridge. Do not print or paste its value.
- The probe tests delivery through the configured public Worker and Tunnel. It does not create a new Linear Agent Session, task file, or job ledger record.

## Independent hostname verification

The five Worker custom domains are configured in each `linear-*-worker/wrangler.jsonc` and are **not** the same as the Tunnel hostnames. You may override them through `ANTIGRAVITY_WORKER_HOST`, `CHATGPT_WORKER_HOST`, `TRAE_WORKER_HOST`, `GEMINI_WORKER_HOST`, and `MOCK_WORKER_HOST`. Defaults use `linear-${PREFIX}.${DOMAIN}`, with per-agent `*_PREFIX` environment values. The separate direct Tunnel check tests the existing `*_HOST` endpoints.

The Workers must first be deployed from this feature branch. A 404 from the Worker custom domain can indicate an older deployed Worker; a 403 can indicate Cloudflare WAF. Preserve the existing webhook IP restrictions and allow only authenticated diagnostic requests by a narrowly scoped rule.

## Review hardening

- `bridge:doctor` verifies the exact expected Worker `SERVICE_NAME` (using `*_PREFIX`) for both Worker `GET /health` and Worker forwarding results; it rejects a different Worker even if that Worker can reach the bridge.
- The direct Tunnel probe also checks the reported local `agent` identity against its hostname, not just the echoed UUID.
- The local health URL uses `BRIDGE_HOST` and `BRIDGE_PORT` from the trusted root environment.
- The direct Tunnel `GET /health` request was removed. Only `POST /diagnostics/probe` must pass the narrow WAF rule on Tunnel hostnames. Worker custom domains need access to both `GET /health` and authenticated `POST /diagnostics/probe` from the trusted diagnostic caller.
