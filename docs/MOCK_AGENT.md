# Mock Agent

A fifth, **isolated** Linear app for exercising the assignment -> local queue -> issue status -> comment loop. It queues jobs only; it never executes arbitrary code.

## Linear and Cloudflare setup (manual)

1. Create a new Linear OAuth agent app for Mock Agent with the same OAuth permissions and webhook configuration as the existing Antigravity agent.
2. Create a **new** Cloudflare KV namespace; set its ID in `linear-mock-worker/wrangler.jsonc` (do not reuse another agent's KV namespace).
3. Configure `linear-mock.revrebel.io` for OAuth and webhook traffic and `mock-agent.revrebel.io` to forward to the local bridge's existing `/jobs` listener through your tunnel. Verify routing and security before enabling.
4. Add `MOCK_LINEAR_CLIENT_ID`, `MOCK_LINEAR_CLIENT_SECRET`, `MOCK_LINEAR_WEBHOOK_SECRET`, and `MOCK_HOST=mock-agent.revrebel.io` to your local ignored root `.env`. Configure the Worker secrets including `BRIDGE_SHARED_SECRET`.
5. This Worker intentionally is **not included in the existing root workspaces** or global deploy scripts. Run `npx wrangler deploy --config linear-mock-worker/wrangler.jsonc` only after completing KV, DNS, OAuth, tunnel and secret setup.

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
