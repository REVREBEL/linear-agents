# Linear → ChatGPT Cloudflare Worker

This Worker handles the Linear-facing portion of an ChatGPT agent integration:

- starts Linear OAuth with `actor=app`
- requests assignable and mentionable app scopes
- handles the OAuth callback
- stores per-workspace access and refresh tokens in Workers KV
- verifies Linear webhook signatures
- deduplicates retried webhook deliveries
- forwards verified agent-session payloads to a service running on your Mac through a Cloudflare Tunnel

## Important boundary

This Worker does **not** start ChatGPT by itself. `CHATGPT_BRIDGE_URL` must point to a local receiver on your Mac exposed through Cloudflare Tunnel. That receiver is responsible for translating the Linear payload into whatever ChatGPT command, extension, or agent interface you use.

The Worker does not forward your Linear OAuth token to the Mac.

## 1. Install dependencies

```bash
npm install
```

## 2. Create KV namespaces

```bash
npx wrangler kv namespace create LINEAR_CHATGPT_DATA
npx wrangler kv namespace create LINEAR_DATA --preview
```

Copy the returned IDs into `wrangler.jsonc`.

## 3. Choose the Worker URL

Deploy once to learn the `workers.dev` URL:

```bash
npx wrangler deploy
```

It will look similar to:

```text
https://linear-ChatGPT-agent.<your-subdomain>.workers.dev
```

Update `LINEAR_REDIRECT_URI` in `wrangler.jsonc`:

```text
https://linear-ChatGPT-agent.<your-subdomain>.workers.dev/oauth/callback
```

Set the Linear application fields to:

```text
Redirect URI:
https://linear-ChatGPT-agent.<your-subdomain>.workers.dev/oauth/callback

Webhook URL:
https://linear-ChatGPT-agent.<your-subdomain>.workers.dev/webhook
```

Keep **Agent session events** selected in Linear.

## 4. Configure the Mac bridge URL

Create a Cloudflare Tunnel hostname that points to the local receiver on your Mac, for example:

```text
https://ChatGPT-agent.revrebel.io
    → http://localhost:8788
```

Then set this in `wrangler.jsonc`:

```json
"CHATGPT_BRIDGE_URL": "https://ChatGPT-agent.revrebel.io/jobs"
```

## 5. Add Worker secrets

Because the webhook signing secret appeared in a screenshot, rotate it in Linear before adding it here.

```bash
npx wrangler secret put LINEAR_CLIENT_ID
npx wrangler secret put LINEAR_CLIENT_SECRET
npx wrangler secret put LINEAR_WEBHOOK_SECRET
npx wrangler secret put BRIDGE_SHARED_SECRET
```

Use a long random value for `BRIDGE_SHARED_SECRET`. The same value must be configured in the receiver on your Mac.

For local development:

```bash
cp .dev.vars.example .dev.vars
```

Then fill in `.dev.vars`. Never commit it.

## 6. Deploy

```bash
npm run deploy
```

## 7. Install the app into Linear

Open:

```text
https://linear-ChatGPT-agent.<your-subdomain>.workers.dev/install
```

The Worker constructs the authorization URL with:

```text
actor=app
scope=read,write,app:assignable,app:mentionable
```

After authorization, Linear redirects to `/oauth/callback`, and the Worker stores the installation in KV.

## 8. Test

Health check:

```bash
curl https://linear-ChatGPT-agent.<your-subdomain>.workers.dev/health
```

Expected response:

```json
{
  "ok": true,
  "service": "linear-ChatGPT-agent"
}
```

Delegate a Linear issue to the installed ChatGPT Agent. The Worker should accept the `AgentSessionEvent` and forward it to the Mac bridge.

Inspect logs:

```bash
npx wrangler tail
```

## Routes

| Route | Purpose |
|---|---|
| `GET /` | status and install link |
| `GET /health` | health check |
| `GET /install` | starts Linear app OAuth |
| `GET /oauth/callback` | completes OAuth and stores the installation |
| `POST /webhook` | verifies and forwards Linear events |

## Mac receiver contract

The Worker makes this request:

```http
POST /jobs
Authorization: Bearer <BRIDGE_SHARED_SECRET>
Content-Type: application/json
X-Linear-Webhook-Id: <webhook-id>
```

Body:

```json
{
  "source": "linear",
  "receivedAt": "2026-07-03T12:00:00.000Z",
  "organizationId": "...",
  "payload": {
    "...": "the verified Linear webhook payload"
  }
}
```

The Mac receiver should return any `2xx` response quickly after accepting the job.

## Production notes

- Keep the Mac receiver behind Cloudflare Tunnel rather than opening a router port.
- Add Cloudflare Access service-token validation in addition to the shared bearer secret when ready.
- Agent-session `created` events should produce a Linear activity or external URL within ten seconds. This starter forwards immediately, but your Mac receiver still needs to acknowledge the session through Linear as part of the final ChatGPT integration.
- KV is eventually consistent. It is suitable for this initial single-workspace bridge, but a more complex multi-workspace product may benefit from Durable Objects or D1 for coordination.
