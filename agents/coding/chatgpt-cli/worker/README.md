# ChatGPT CLI Worker (OpenCode)

The LinearBridge ChatGPT CLI coding agent has its own Cloudflare Worker, now colocated under `agents/coding/chatgpt-cli/worker/`.

**Identity boundaries:** The deployed Worker remains `linear-chatgpt-cli-agent` (distinct from the ChatGPT reviewer Worker `linear-chatgpt-agent`). Both use the registered ChatGPT Linear OAuth app credentials, but their Cloudflare Worker deployments, routes, KV namespaces, and duties remain separate. The legacy static Wrangler `name` is intentionally preserved as an input-template value; `scripts/render-wrangler.mjs` overrides it from `CHATGPT_CLI_PREFIX`. Moving this folder must not rename or redeploy the Worker.

The bridge launches ChatGPT CLI coding tasks through OpenCode on the configured runtime host. Code-review inbox delivery for ChatGPT's separate review-user identity must not be redirected to this Worker.

From the repository root, verify:

```bash
npm ci
npm run registry:validate
npm run types -- chatgpt-cli
npm run typecheck
npm run test:reliability
```

Physical paths are resolved through `agents/registry.json`. Generate short-lived Wrangler configuration through the existing environment scripts; do not commit secrets, KV IDs, access tokens or `wrangler.local.*` files. Deployments, OAuth changes, and Ubuntu service restarts require separate approval.
