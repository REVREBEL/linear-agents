# AGENTS.md

## Project: REVREBEL Linear Agents

This repository bridges Linear app agents to local project-specific automation on a Mac through Cloudflare Workers, Cloudflare Tunnel and a Node.js job router. Read this file before modifying any agent, webhook, route or runner.

## Source of truth
- `linear-agent-bridge/agent-bridge.mjs`: hostname-based local HTTP bridge, default `127.0.0.1:8788`.
- `linear-agent-bridge/job-store.mjs`: persistent filesystem job lifecycle and deduplication ledger.
- `linear-agent-bridge/run_agent.py`: Antigravity (AGY) runner, Linear Agent Activity and quota-exhaustion signal.
- `linear-agent-bridge/ROUTING.md` and local ignored `linear-agent-bridge/routing.json`: project/initiative to repository and workspace routing.
- `linear-{antigravity,chatgpt,gemini,trae,mock}-worker/`: five independently deployed Linear OAuth/webhook Workers.
- `scripts/chatgpt-playwright/handoff-test.mjs`: ChatGPT browser handoff and terminal test runner.
- `scripts/with-env.sh`, `scripts/bridge.sh`, `scripts/macos/`: environment, bridge operation and macOS LaunchAgent support.
- `docs/`: operational documentation; check actual code before trusting historical audit snapshots.

## Request path
Linear Agent Session webhook -> appropriate Worker `/webhook` -> signed event verification and Linear metadata enrichment -> Worker forwards authenticated `POST /jobs` to Tunnel -> local bridge selects agent based on Host -> resolves project route -> saves task under `<repo>/.linear-agent/projects/<project-uuid>/inbox/<delivery-id>.json` -> invokes runner or queues handoff.

Workers use OAuth installation tokens stored in `LINEAR_DATA` KV. Local bridge jobs use `BRIDGE_SHARED_SECRET`. Keep Worker/public hostnames distinct from Tunnel hostnames. Don't log, copy into commits, or echo secrets.

## Routing invariants
- Route by structured Linear project UUID, not project name or guessed issue text. Initiative can select a repository; explicitly mapped standalone projects can name a repository directly.
- Resolve actual repository and optional scope from `routing.json`, enforcing repository boundaries. `launchFromScope` is opt-in.
- An unroutable job must fail safely rather than launch into a default repository.
- The bridge writes local runtime task files under `.linear-agent/`; exclude them from Git.
- Repeated webhook deliveries must not start duplicate agent work.
- The repository may contain multiple simultaneous Linear issues and AGY conversations; never use `agy -c` or a global `last_session` as an issue identity.

## Agent-specific behavior
- **Antigravity**: `run_agent.py` invokes the AGY CLI with stream-json input/output, workspace cwd and sandbox. AGY quota failures can emit `AGY_BRIDGE_EVENT` with `on_exhaustion` and an actual AGY conversation ID; bridge saves `waiting_quota`, waits two hours by default (`AGY_RETRY_DELAY_MS=7200000`), then resumes that exact conversation with a short continuation prompt. Retry cap is three. If no exact conversation ID is available, do not resume an arbitrary session. Retry behavior requires real CLI compatibility and live verification.
- **ChatGPT**: project routing supports an existing ChatGPT conversation and optional Playwright automatic submission. Browser handoff is not the same thing as detecting ChatGPT responses. ChatGPT handles its own Linear responses via connected tools; do not add response scraping.
- **Gemini and Trae**: dispatched through configured local runners.
- **Mock**: manual end-to-end testing via `npm run mock:submit -- --job PATH` and `npm run mock:end -- --job PATH`.

## Lifecycles and completion
Agent Session completion and Linear issue workflow completion are different. `/complete` emits a session activity; it does not mark the issue Done. Job inbox JSON is only cleared on an authenticated `/issue-completed` event after the issue is confirmed completed. Do not delete it when an agent stops, fails, or reaches quota.

## Development commands
```bash
npm ci
npm run bridge:test
npm run types
node --check linear-agent-bridge/agent-bridge.mjs
node --check linear-agent-bridge/job-store.mjs
python3 -m py_compile linear-agent-bridge/run_agent.py
npm run bridge:status
npm run bridge:restart
```

Use `npm run deploy -- <agent>` for a Worker and the `scripts/with-env.sh` wrapper when root `.env` injection/secrets are needed. Code commits do not automatically deploy Workers or restart the local macOS bridge. Do not claim checks passed unless actually executed.

## Documentation and change discipline
1. Inspect current implementation and routing before editing; historical docs may describe superseded paths and behaviors.
2. Keep the root README, `docs/AGENT_BRIDGE_ARCHITECTURE_AND_OPERATIONS.md`, `linear-agent-bridge/ROUTING.md`, environment example and affected Worker docs consistent with behavior changes.
3. Prefer minimal targeted changes; preserve security checks, agent/session identity, job idempotency and issue-vs-session distinction.
4. For any new retry/resume mechanism, document persistence, maximum retries, restart recovery, concurrency and failure conditions; add tests where possible.
5. Never commit real OAuth credentials, app secrets, local `.env`, private project routing values or task payloads.
