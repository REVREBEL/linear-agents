# ChatGPT Review Worker

This Cloudflare Worker handles Linear and GitHub events for the **ChatGPT review identity**, not ChatGPT CLI coding execution. Its source lives in `agents/bridge/reviewer/worker/`.

The deployed identity remains `linear-chatgpt-agent` with the existing Linear and GitHub custom domains, `LINEAR_DATA` KV binding, `DELIVERY_COORDINATOR` Durable Object, and shared ChatGPT Linear OAuth application registration.

**Keep review and coding separate:** The ChatGPT CLI Worker uses the separate deployment `linear-chatgpt-cli-agent`, separate KV namespace, and a coding-focused OpenCode runtime. The two Workers share their Linear OAuth app credentials but must not share their Cloudflare Worker or KV identities. Review handoffs and inbox delivery are handled by the existing bridge and review consumer; moving files here does not change those contracts.

From the repository root, verify:

```bash
npm ci
npm run registry:validate
npm run types -- chatgpt
npm run typecheck
npm run test:reliability
```

The physical path is resolved from `agents/registry.json`; `scripts/with-env.sh` and `scripts/render-wrangler.mjs` generate local configuration using environment variables. Never commit secrets or generated Wrangler files. This source migration does **not** deploy a Worker, rotate credentials, modify callback URLs, restart the Ubuntu bridge, or migrate historical job state.


## ABR-18 Phase 2A — signed no-prompt Linear notifications

When `EVENT_INTELLIGENCE_MODE=shadow` is explicitly configured on this
reviewer Worker **and** on the Bridge, a Linear AppUserNotification
with no explicit `promptContext` is no longer silently ignored.
The existing Linear HMAC validation, signed timestamp freshness, per-org
Durable Object queue and independently refreshed OAuth installation
must succeed before the notification is interpreted.

The Worker derives its delivery key from SHA-256 of the **signed body**,
not an unsigned header, fetches the linked issue using the authorized
Linear OAuth app, and confirms issue ID, installed organization, current
state and project. A notification GitHub URL is only a **PR candidate**:
the Bridge never treats it as GitHub-verified review/head/check evidence.
The private Bridge endpoint `/event-intelligence/intake` accepts only this
reviewer identity and separate Bridge bearer, and responds 202 only after
the metadata record is durably persisted. Failure is 503/retryable, not a
false successful review. Duplicate deliveries are idempotent.

A 202 is **durable intake**, not `/jobs` agent dispatch, a launched
review, a published GitHub review, or Linear completion. The returned
`dispatchStatus` and `reviewLaunchStatus` are always `not_started`.
Normal AgentSessionEvent handling, coding agents and legacy review
notification behavior are unchanged. Shadow mode is **off** unless
explicitly enabled; source changes do not deploy this Worker or change
any production environment or credentials.


The intake uses a **different**, minimum 32-character reviewer-only
`EVENT_INTELLIGENCE_INTAKE_TOKEN` secret in the Cloudflare reviewer Worker.
The Bridge must have the exact corresponding secret in its protected
environment. It must **not** use `BRIDGE_SHARED_SECRET`: the latter
authenticates coding `/jobs` callers and does not establish reviewer identity.
Missing intake credentials fail closed (503) with no KV delivery claim.
