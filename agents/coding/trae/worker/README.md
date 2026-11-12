# Trae Worker

This Cloudflare Worker handles Linear OAuth, authenticated webhooks, Durable Object delivery coordination and forwarding to the Trae agent bridge. Its source is colocated under `agents/coding/trae/worker/`.

The deployed script identity stays `linear-trae-agent`, with the existing `LINEAR_DATA` KV binding and `DELIVERY_COORDINATOR` Durable Object. Trae's macOS routing and activity/completion callbacks remain governed by the existing bridge and Tunnel configuration, not by the source folder.

Use the repository-root commands for verification:

```bash
npm ci
npm run registry:validate
npm run types -- trae
npm run typecheck
npm run test:reliability
```

Configuration flows through `agents/registry.json`, `scripts/with-env.sh` and `scripts/render-wrangler.mjs`. Never commit KV IDs, .env files, secrets or generated Wrangler files. Folder colocation does not authorize deploying, changing credentials, modifying the callback endpoints or restarting the Ubuntu bridge.
