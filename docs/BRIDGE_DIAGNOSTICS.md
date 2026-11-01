# LinearBridge diagnostics

## Commands

```bash
npm run bridge:status
npm run bridge:doctor
```

`bridge:status` remains fast and local. `bridge:doctor` reads the root `.env` using `scripts/bridge.sh`, checks the local router, resolves each configured agent hostname, queries the public Worker `/health`, then sends a unique probe through Worker `/diagnostics/probe` → Cloudflare Tunnel → local router `/diagnostics/probe`.

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
