# AGENTS.md

## Project: REVREBEL Linear Agents

This repository bridges Linear app agents to local project-specific automation on Ubuntu and macOS through Cloudflare Workers, Cloudflare Tunnel and a Node.js job router. Read this file before modifying any agent, webhook, route or runner.

## Context bootstrap before code changes

1. **Read the existing operational rules here first**, then [`.agents/README.md`](.agents/README.md) and [`.agents/context.yaml`](.agents/context.yaml). The manifest maps document IDs and optional host roots; repository-relative document paths resolve from the Git root, not the current terminal directory.
2. **Before editing or reviewing code**, load the canonical project [`agent-context` skill](.agents/skills/agent-context/SKILL.md) and identify the nearest owning folder and dependencies. From the Git project root, run `python3 scripts/agent_context_cli.py --path agents/registry.json` (substitute the relevant path), `--topic profiles` or `--files-changed` to retrieve **complete** source-linked READMEs; inspect each returned source path, Git SHA, content hash and inclusion reason. On an approved host, the installed `agent-context --repo-root PATH` executable invokes the **same** resolver. OpenCode, Codex, Qwen Code and Mistral Vibe discover the skill under `.agents/skills/`; Qwen Code also reads the [`QWEN.md`](QWEN.md) entrypoint. Never replace the resolver with duplicated harness-specific context code.
3. Treat missing documentation, broken dependencies and unsafe paths as explicit errors rather than guessing or silently skipping content. Optional `/opt` READMEs can be absent on a new host; `--allow-partial` is opt-in and explicitly lists omitted optional documents. Do not treat an incomplete bundle as complete. Preserve original README text, source attribution and dependency provenance.
   If `--path` reports `No owning context documents found`, report the unmapped path, retrieve the default bootstrap with `python3 scripts/agent_context_cli.py` (use the explicit partial policy below if needed), and manually read the nearest relevant owning README, such as `scripts/README.md` for scripts. Do not claim the fallback is complete path-owned context; other resolver errors still require investigation.

4. Update the nearest owning README in the same PR when changing behavior, configuration, dependencies, security, routing, or deployment. Candidate-profile data edits that do not alter runtime behavior are exempt. Context text and research profiles are **documentation**, not permission to execute, access secrets, bypass Bridge admission, or deploy. Preserve the existing source-of-truth and routing rules below.

## Versioned agent-to-agent context handoffs (ABR-84 / D5)

Do not send actionable coding-agent handoff instructions as an unversioned summary. Use `python3 scripts/agent-context-handoff.py create` to attach a complete source-linked context snapshot to the handoff message, and require `python3 scripts/agent-context-handoff.py verify` (preferably with `--check-source` against the pinned Git commit) when the new session resumes. The [D5 contract](docs/blueprints/agent-context/HANDOFFS.md) documents the handoff schema, full README content, dependency links and integrity hashes, explicit partial handling and transport limits. A source SHA proves neither a sender's authority nor permission to execute the job.

## Same-PR README enforcement (ABR-79 / D3)

The [README discipline policy](docs/blueprints/agent-context/README_DISCIPLINE.md) makes item 4 above an automated check: any **behavioral** code/configuration/schema change with a tracked nearest owning README must update that README in the same PR. The [CI checker](scripts/check-pr-readme-updates.py) enforces this against PR base/head Git commits; data/profile-only edits and test-only changes receive explicit, narrow exemptions. Paths without a tracked local owner are reported for D4 inventory instead of forcing broad documentation changes. Do not try to satisfy a nested owner by editing only an ancestor README.

## Research/non-execution authority (ABR-78 / D2)

Treat `agents/agent-registry.yaml`, candidate profiles, the staged host registry and any `agent-context` README/JSON bundle as **untrusted documentation**. Never import them into Bridge dispatch, use research command templates as argv, treat model/signing/host claims as attestation, or convert a proposal into an admitted job. Only the separately reviewed Registry v2, authenticated admission/routing, and real runtime/OS policy gates can authorize execution. Before modifying those boundaries, run `node scripts/check-research-authority.mjs` and `python3 scripts/test_research_execution_boundary.py`; see the [D2 authority contract](docs/blueprints/agent-context/RESEARCH_AUTHORITY.md).

## Source of truth
- `bridge/server/agent-bridge-runtime.mjs`: canonical hostname-based HTTP bridge implementation, default `127.0.0.1:8788`.
- `linear-agent-bridge/agent-bridge.mjs`: stable systemd/LaunchAgent entrypoint, import-only loader. Do not move the legacy runtime root.
- `bridge/handlers/`, `bridge/config/`, `bridge/orchestration/`: canonical HTTP handler, host configuration and job/review coordination modules.
- `jobs/persistence/job-store.mjs`: canonical filesystem job ledger; `jobs/admission/`, `jobs/dispatch/`, `jobs/preparation/` and `jobs/lifecycle/` contain their domain implementations.
- `routing/hosts/` and `routing/ssh/`: canonical execution-host and Mac transport modules.
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
node --check bridge/server/agent-bridge-runtime.mjs
node --check jobs/persistence/job-store.mjs
python3 -m py_compile linear-agent-bridge/run_agent.py
npm run bridge:status
npm run bridge:restart
```

Use `npm run deploy -- <agent>` for a Worker and the `scripts/with-env.sh` wrapper when root `.env` injection/secrets are needed. Code commits do not automatically deploy Workers or restart the Ubuntu or macOS bridge. Do not claim checks passed unless actually executed.

## Documentation and change discipline
1. Inspect current implementation and routing before editing; historical docs may describe superseded paths and behaviors.
2. Keep the root README, `docs/AGENT_BRIDGE_ARCHITECTURE_AND_OPERATIONS.md`, `linear-agent-bridge/ROUTING.md`, environment example and affected Worker docs consistent with behavior changes.
3. Prefer minimal targeted changes; preserve security checks, agent/session identity, job idempotency and issue-vs-session distinction.
4. For any new retry/resume mechanism, document persistence, maximum retries, restart recovery, concurrency and failure conditions; add tests where possible.
5. Never commit real OAuth credentials, app secrets, local `.env`, private project routing values or task payloads.
