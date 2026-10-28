# Mock Agent

## Current Mock Agent CLI workflow (verified 2026-10-28)

The Mock Agent uses its own OAuth app identity when operated through the Mock Worker's `/mock-action` endpoint. **Use `npm run mock:submit` for comments and issue-status changes, not `mock:agent`**, when the action must appear under the connected Mock Agent. The legacy `mock:agent` command uses a personal `LINEAR_API_KEY`, and comments can be attributed to that human user.

```bash
npm run mock:submit -- --job "/absolute/path/to/scoped-job.json"
# Or explicitly supply --issue REV-123 --organization ORGANIZATION_UUID
npm run mock:end -- --job "/absolute/path/to/scoped-job.json"
```

`mock:submit` opens the current issue and workflow statuses, prompts for a comment and optional status, and requires explicit `YES` confirmation. It uses the shared-secret-authenticated Mock Worker endpoint, which performs the action using the Mock app's installed OAuth credentials. `mock:end` sends a `completed` or `failed` **session** result to the validated `https://linear-mock.revrebel.io/complete` URL and requires explicit confirmation. Neither session completion nor a posted comment deletes the local job inbox; the Linear issue must enter a completed workflow state.

The compact job format uses top-level `agentSessionId`, `completionUrl`, and `organizationId`, plus `payload.data.promptContext` and optional issue metadata. **`payload.original` is no longer a guaranteed field.** The current submit utility still has backward-compatible reads from that older field, but falls back to `issueMetadata`, `issueId`, or an issue key in the task prompt (`Issue: REV-123`, an `<issue identifier="REV-123">` tag, or a Linear issue URL). The end utility likewise extracts an identifier from issue metadata/prompt. Supply `--issue` if extraction is ambiguous.

**Legacy note:** sections below mentioning `linear-mock.yourdomain.com`, `mock-agent.yourdomain.com`, mandatory initiative mappings, or `mock:agent` as the app-identity posting workflow are historical setup instructions. The actual production hostnames are `linear-mock.revrebel.io` and `mock-agent.revrebel.io`; standalone projects work when explicitly mapped in `routing.json`.

---


A fifth, **isolated** Linear app for exercising the assignment -> local queue -> issue status -> comment loop. It queues jobs only; it never executes arbitrary code.

## Linear and Cloudflare setup (manual)

1. Create a new Linear OAuth agent app for Mock Agent with the same OAuth permissions and webhook configuration as the existing Antigravity agent.
2. Run `npm run setup:kv -- mock` to create or reuse a dedicated Mock KV namespace and write `MOCK_KV_NAMESPACE_ID` into the ignored root `.env`. Do not share it with another agent.
3. Configure `linear-mock.yourdomain.com` for OAuth and webhook traffic and `mock-agent.yourdomain.com` to forward to the local bridge's existing `/jobs` listener through your tunnel. Verify routing and security before enabling.
4. Add `MOCK_LINEAR_CLIENT_ID`, `MOCK_LINEAR_CLIENT_SECRET`, `MOCK_LINEAR_WEBHOOK_SECRET`, and `MOCK_HOST=mock-agent.yourdomain.com` to your local ignored root `.env`. Configure the Worker secrets including `BRIDGE_SHARED_SECRET`.
5. The Mock Worker is included in the npm workspaces. After completing KV, DNS, OAuth, tunnel and secret setup, use `npm run deploy -- mock`, which also synchronizes the four secrets from the ignored root `.env`. Avoid `deploy -- all` until every Worker is configured.

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

## Automating KV namespace setup

Configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (KV namespace read/write permission), and `MOCK_PREFIX=mock` in the ignored root `.env`. Then run:

```bash
npm run setup:kv -- mock
npm run types -- mock
npm run deploy -- mock
```

`setup:kv` uses Cloudflare's API to find the existing namespace named `LINEAR_MOCK_DATA`; if absent, it creates it. The script updates the existing empty `MOCK_KV_NAMESPACE_ID=` line in the ignored `.env` or appends that key if missing. Existing nonempty IDs are checked against Cloudflare and are never overwritten; conflicting or duplicate namespaces fail safely. Run `npm run setup:kv -- all` to provision all five. This creates KV namespaces only; it does not deploy a Worker, configure DNS, synchronize secrets, or install the app in Linear.

## Runtime variables versus secrets

`npm run deploy -- mock` publishes the four non-secret Worker `vars` from the rendered configuration: `BRIDGE_URL`, `LINEAR_REDIRECT_URI`, `LINEAR_SCOPES`, and `SERVICE_NAME`. After a successful Wrangler deployment, it now also publishes `BRIDGE_SHARED_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` as encrypted Cloudflare Worker secrets. All five agents use this flow. The command checks that all four source secrets are set before deploying; a failed secret upload returns an error. For secrets-only updates, run `bash scripts/with-env.sh worker mock sync-secrets`.

## Automatic Worker Custom Domain

During `npm run deploy -- mock`, the private Wrangler configuration now includes a Cloudflare Custom Domain route for `linear-mock.yourdomain.com`. The generator derives this from `MOCK_PREFIX` and `DOMAIN` and uses `custom_domain: true`. The same behavior applies to all five Workers. The bridge/Tunnel hostname `mock-agent.yourdomain.com` is **not** attached as a Worker route. You must configure the Tunnel separately. A conflicting DNS CNAME on the Worker hostname must be removed before Cloudflare can attach it; do not delete a CNAME on the bridge hostname. Worker custom-domain creation requires the relevant Cloudflare permissions and zone ownership. This route is reconciled on each deployment, not only the first.
