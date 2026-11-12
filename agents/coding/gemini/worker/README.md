# Gemini Worker

This is the Cloudflare edge Worker for the Gemini agent in the REVREBEL Agent Bridge.

The service name remains `linear-gemini-agent`, with the existing `LINEAR_DATA` KV binding and `DELIVERY_COORDINATOR` Durable Object. Moving this source folder does not change the deployed Worker, OAuth application, hostnames or bridge routing.

Use the repository root commands to configure and test this Worker:

```bash
npm ci
npm run registry:validate
npm run types -- gemini
npm run typecheck
npm run test:reliability
```

The registry in `agents/registry.json` determines the physical Worker directory. `scripts/with-env.sh` and `scripts/render-wrangler.mjs` generate untracked deployment configuration from the trusted local environment. Do not commit KV namespace IDs, credentials, tokens, or generated runtime files.

A deployment requires a separate authorization; moving folders and passing tests do not authorize production changes.
