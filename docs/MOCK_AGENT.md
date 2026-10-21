# Mock Agent

A fifth, **isolated** Linear app for exercising the assignment -> local queue -> issue status -> comment loop. It queues jobs only; it never executes arbitrary code.

## Linear and Cloudflare setup (manual)

1. Create a new Linear OAuth agent app for Mock Agent with the same OAuth permissions and webhook configuration as the existing Antigravity agent.
2. Create a **new** Cloudflare KV namespace; set `MOCK_KV_NAMESPACE_ID` in the ignored root `.env` (do not reuse another agent's KV namespace).
3. Configure `linear-mock.yourdomain.com` for OAuth and webhook traffic and `mock-agent.yourdomain.com` to forward to the local bridge's existing `/jobs` listener through your tunnel. Verify routing and security before enabling.
4. Add `MOCK_LINEAR_CLIENT_ID`, `MOCK_LINEAR_CLIENT_SECRET`, `MOCK_LINEAR_WEBHOOK_SECRET`, and `MOCK_HOST=mock-agent.yourdomain.com` to your local ignored root `.env`. Configure the Worker secrets including `BRIDGE_SHARED_SECRET`.
5. The Mock Worker is included in the npm workspaces. After completing KV, DNS, OAuth, tunnel and secret setup, use `npm run deploy -- mock` and `bash scripts/with-env.sh worker mock sync-secrets`. Avoid `deploy -- all` until every Worker is configured.

## Install the agent in Linear

The install endpoint is `https://linear-mock.yourdomain.com/install`, not `https://mock-agent.yourdomain.com`. The former is the Cloudflare Worker; the latter is the tunnel forwarding `/jobs` to the local bridge. Configure and deploy the Worker, attach its custom domain in Cloudflare, synchronize Worker secrets, then visit `/install` to authorize the Linear OAuth app. Check `/health` on the Worker first.

In Linear, register Mock Agent as an OAuth app, enable Agent Session webhook events, set callback to `https://linear-mock.yourdomain.com/oauth/callback` and webhook to `https://linear-mock.yourdomain.com/webhook`, and request `read,write,app:assignable,app:mentionable` scopes. Set the app credentials in the ignored root `.env` using `MOCK_LINEAR_CLIENT_ID`, `MOCK_LINEAR_CLIENT_SECRET`, and `MOCK_LINEAR_WEBHOOK_SECRET`. The Worker uses `actor=app` to authorize installation into a workspace. After deployment, run `bash scripts/with-env.sh worker mock sync-secrets`; visit the installation URL and approve the workspace authorization.

Cloudflare Worker Custom Domain `linear-mock.yourdomain.com` must be attached in **Workers & Pages → linear-mock-agent → Settings → Domains & Routes**. The separate Tunnel public hostname `mock-agent.yourdomain.com` must forward to `http://127.0.0.1:8788`. Do not point the Worker domain to the Tunnel, or the Tunnel domain to the Worker.

Cloudflare Error 1014 (CNAME Cross-User Banned) concerns DNS or hostname association, not IP allowlisting. Check the tunnel hostname's CNAME target and account association.

## Inspect a received job

Mock delivery state is stored under `~/.linear-agents/linear-agent-bridge/linear-jobs/job-state`; unroutable Mock requests are saved under `linear-jobs/mock`. Successfully routed jobs are stored in the target repository's `.linear-agent/projects/<Linear-project-UUID>/inbox/` folder. Find the file path in the bridge log. Then:

```bash
cd ~/.linear-agents
npm run mock:agent -- inspect --job "/absolute/path/to/scoped-job.json"
```

The issue ID is extracted from the original signed agent-session payload. If your test payload differs, pass `--issue YOUR-123` explicitly.

## Manually advance status and post a comment

```bash
npm run mock:agent -- status --job "/absolute/path/to/scoped-job.json" --to in-progress
npm run mock:agent -- status --job "/absolute/path/to/scoped-job.json" --to in-review
npm run mock:agent -- comment --job "/absolute/path/to/scoped-job.json" --message "Mock Agent handoff test"
npm run mock:agent -- status --job "/absolute/path/to/scoped-job.json" --to completed
```

The CLI loads `LINEAR_API_KEY` from your ignored root `.env` via `scripts/with-env.sh` and asks for explicit `YES` approval before each write. Use `--yes` only for controlled test automation. Status names are resolved against the issue team's actual workflow; missing or ambiguous statuses fail safely. Configure the key securely before running. Do not use `--yes` on non-test issues.

**Important:** This scaffold does not yet dispatch from the new Linear app until its Worker is deployed, tunnel host mapped, and Linear app installed; it does not verify your Cloudflare configuration or the live webhook payload. The existing bridge requires a Linear project plus exactly one mapped initiative and repository, so put the test issue in a mapped project.

## Private Worker configuration

Put `DOMAIN=yourdomain.com` and `MOCK_KV_NAMESPACE_ID=<namespace ID>` in the ignored root `.env`. The committed `wrangler.jsonc` contains explicit `${MOCK_KV_NAMESPACE_ID}`, `${MOCK_PREFIX}`, and `${DOMAIN}` template strings. Wrangler itself does not expand them; the npm wrapper renders them into a temporary config before running Wrangler. Do not run raw `wrangler deploy` against the tracked template. `npm run types -- mock` and `npm run deploy -- mock` load `.env`, write an untracked temporary Wrangler configuration, use it, and delete it after completion. The OAuth redirect and bridge URLs are derived from `DOMAIN`, not committed. The same process applies to all five agents.
