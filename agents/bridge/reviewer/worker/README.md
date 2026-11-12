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
