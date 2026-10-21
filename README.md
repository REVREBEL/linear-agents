## macOS LaunchAgent

For a login-started local bridge, use the [macOS LaunchAgent setup guide](docs/MACOS_LAUNCHAGENT.md) and [validated plist template](scripts/macos/agent-bridge.plist.example). Run `bash scripts/macos/install-launchagent.sh` after configuring the root `.env`. This installs the plist without restarting the running bridge.

## Node.js dependencies and npm workspaces

The four Cloudflare Workers are npm workspaces managed from the repository root. Run **one** installation from the root rather than `npm install` in each Worker folder. The root `package-lock.json` is the canonical lockfile, and dependencies are installed in root `node_modules/`.

```bash
npm install                       # install/update all workspaces (root)
npm ci                            # clean reproducible installation
npm run setup -- all              # equivalent workspace setup shortcut
npm run setup -- gemini           # select Gemini workspace + shared root deps
npm test                           # local job-store tests
npm run types                      # Wrangler types for all four Workers
npm run dev -- gemini              # develop one Worker
npm run deploy -- antigravity      # deploy one Worker
npm run deploy -- all              # deploy all four, sequentially
```

To target a single Workspace directly, npm also supports `npm run dev --workspace=linear-trae-worker` (and the corresponding `deploy`/`types` scripts). `npm run dev -- all` is intentionally disallowed because a Wrangler dev server remains running. `npm install` sets up or updates the shared toolchain, while `npm ci` installs exactly the locked dependency versions. `npm run setup -- <agent>` limits the workspace selection but still installs root-level shared dependencies; it does not create a separate `node_modules` per agent. The script is called `setup` instead of `install` to avoid npm automatically running it during `npm install`. A Worker can be deployed independently, and each retains its own `wrangler.jsonc`, KV binding, and OAuth secrets.

For local development with the root `.env`, continue to use `bash scripts/with-env.sh worker <agent> dev`. For production, `bash scripts/with-env.sh worker <agent> deploy` and `... sync-secrets` remain supported. The wrapper now uses `node_modules/.bin/wrangler` from the root, so install dependencies first. **Do not use `npm run deploy` as a substitute for syncing secrets or configuring Cloudflare credentials.** The Python bridge environment remains separate in `linear-agent-bridge/.venv/`.

## Local environment and Terraform

All local credentials and Cloudflare resource IDs are configured through one root [`.env.example`](.env.example). Copy it to an ignored `.env`. Use [`scripts/with-env.sh`](scripts/with-env.sh) to load that file for Terraform, local Worker development, production Worker secret uploads and manual bridge launches. No per-Agent `.dev.vars.example` or `.tfvars` file is required. See the [Cloudflare setup guide](infrastructure/cloudflare/README.md) before importing existing security resources; do not run Terraform apply until the deployed WAF ruleset and list are reconciled.

<p align="left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme-banner_dark.jpg" />
    <img src=".github/assets/readme-banner_light.jpg" alt="REVREBEL Linear Agents" />
  </picture>
</p>

# LINEAR AGENTS

**REVREBEL's Linear-to-local-agent integration.** Four independently installed Linear app agents each use a Cloudflare Worker for OAuth, authenticated webhooks, initial Agent Session activity and completion callbacks. Workers forward jobs over Cloudflare Tunnel to a local machine.

> **Repository status:** The canonical hostname router is now checked in at [`.linear-agent-bridge/agent-bridge.mjs`](.linear-agent-bridge/agent-bridge.mjs). The older `chatgpt-bridge.mjs` and `bridge_daemon.py` receivers have been retired. The Antigravity Python runner `run_agent.py` remains at the repository root and may still need to be referenced via `RUN_AGENT_PATH` on the deployed Mac.

## Architecture

```text
Linear (AgentSessionEvent)
  |  signed webhook
  v
linear-<agent>.yourdomain.com          Cloudflare Worker
  |  OAuth token in LINEAR_DATA KV
  |  acknowledge Linear via agentActivityCreate ("thought")
  |  append session-specific /complete command
  |  POST /jobs with shared bearer authentication
  v
<agent>-agent.yourdomain.com           Cloudflare Tunnel
  |
  v
127.0.0.1:8788                     Local bridge
  |  save job + dispatch local CLI (depending on deployed bridge)
  v
Antigravity / Trae / Gemini CLI / ChatGPT file handoff
  |
  +--> POST https://linear-<agent>.yourdomain.com/complete
       Worker issues final "response" or "error" Agent Activity
```

| Agent | Worker directory | Worker hostname | Tunnel hostname |
|---|---|---|---|
| Antigravity | `linear-antigravity-worker/` | `linear-antigravity.yourdomain.com` | `antigravity-agent.yourdomain.com` |
| Trae | `linear-trae-worker/` | `linear-trae.yourdomain.com` | `trae-agent.yourdomain.com` |
| Gemini CLI | `linear-gemini-worker/` | `linear-gemini.yourdomain.com` | `gemini-agent.yourdomain.com` |
| ChatGPT | `linear-chatgpt-worker/` | `linear-chatgpt.yourdomain.com` | `chatgpt-agent.yourdomain.com` |

## Repository

```text
README.md
docs/
  AGENT_BRIDGE_ARCHITECTURE_AND_OPERATIONS.md
linear-antigravity-worker/
linear-trae-worker/
linear-gemini-worker/
linear-chatgpt-worker/
.linear-agent-bridge/
  agent-bridge.mjs      # canonical multi-agent local router
  .trae/               # Trae session-start integration
run_agent.py             # Antigravity CLI runner
```

Each Worker retains its own `wrangler.jsonc`, `src/index.ts`, and workspace `package.json`, while npm dependencies and the lockfile are shared at the root. The shared source is duplicated between Worker folders, so a fix in one does **not** automatically reach the others.

## Setup overview

1. Create a distinct Linear OAuth app for each agent, with an exact callback of `https://linear-<agent>.yourdomain.com/oauth/callback`, webhook `https://linear-<agent>.yourdomain.com/webhook`, Agent session events enabled, and `actor=app` scopes `read,write,app:assignable,app:mentionable`.
2. Set a unique Cloudflare Worker custom domain for each app. Do **not** route Worker hostnames to Tunnel.
3. Configure a Worker KV namespace bound as **`LINEAR_DATA`** in every Worker. The physical namespace ID can differ for each agent.
4. Configure `SERVICE_NAME`, `LINEAR_REDIRECT_URI`, `LINEAR_SCOPES` and `BRIDGE_URL` in its `wrangler.jsonc`.
5. Set Worker secrets `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `BRIDGE_SHARED_SECRET`. Never commit their values.
6. Configure Tunnel hostname `<agent>-agent.yourdomain.com` to the Mac listener on `http://127.0.0.1:8788`. Ensure the actual deployed bridge routes by hostname.
7. From the repository root, run `npm ci` and deploy the selected Worker using `bash scripts/with-env.sh worker <agent> deploy`, then open `https://linear-<agent>.yourdomain.com/install` to complete OAuth.
8. Delegate a non-destructive test issue, verify initial Agent Activity, local delivery, agent acknowledgment and authenticated completion.

Example checks (substitute the correct agent):

```bash
curl -i https://linear-trae.yourdomain.com/health
curl -i https://linear-trae.yourdomain.com/install
curl -i https://linear-trae.yourdomain.com/oauth/callback
cd linear-trae-worker && npx wrangler tail
```

The bare OAuth callback should return a 400 for missing code/state. `/install` should redirect to Linear. Do not publish shared secrets or OAuth authorization codes from log output.

## Initiative / project routing

The Worker enriches Agent Session webhooks using Linear GraphQL: issue → project ID → initiative IDs. The local bridge resolves those IDs using a **local routing.json** file. Initiative selects the repository; project selects the application scope within that repository. The agent launches from the repository root by default to preserve root-level trust and session context. Set `launchFromScope: true` only for projects that deliberately maintain independent subfolder-based CLI sessions.

Copy `[.linear-agent-bridge/routing.example.json](.linear-agent-bridge/routing.example.json)` to `routing.json` in the **live bridge folder**. Set `PROJECTS_ROOT` or edit `projectsRoot` to the actual Mac repositories parent directory. The example is built from the current Linear initiative/project IDs. Verify the GuestBridge repository mapping and any project scopes still set to `.`.

Each successfully routed job is saved beneath the Git repository at `.linear-agent/projects/<Linear-project-UUID>/inbox/` before dispatch. The bridge writes a local `/.linear-agent/` exclusion into `.git/info/exclude` when available. If the initiative, project, or directory mapping is missing, the job is saved under the central `linear-jobs/<agent>/` as `*.unrouted.json`, and the bridge returns HTTP 422 instead of launching into the wrong workspace.

**Deployment note:** The four Workers must be deployed from their respective directories, and the changed local router must be installed/restarted on the Mac. Git commits alone do not replace a live LaunchAgent process or deploy Workers. The Linear GraphQL enrichment schema and live delivery should be validated using a smoke-test Agent Session before depending on it.

## Edge webhook protection

See [Linear Webhook Traffic Protection](docs/LINEAR_WEBHOOK_TRAFFIC_PROTECTION.md) for the proposed WAF rule, `linear_webhooks` IP list, current Linear published source addresses, Worker exposure settings, and pending live Cloudflare verification. The Worker verifies signed webhook bodies; timestamp freshness validation is not yet implemented.

## Worker HTTP routes

| Method and path | Purpose |
|---|---|
| `GET /` | App landing and install link |
| `GET /health` | Worker health |
| `GET /install` | Initiate app OAuth |
| `GET /oauth/callback` | Exchange code and store installation |
| `POST /webhook` | Signature-check and process Linear events |
| `POST /complete` | Authenticated terminal Agent Activity |

**Completion is not the same as issue status:** `/complete` emits a terminal Agent Activity, but the current Worker does not automatically update the Linear issue's workflow status to Done. The agent must update the issue separately.

**Completion authentication:** the injected curl uses `$BRIDGE_SHARED_SECRET`, which must actually exist in the executing agent's environment. Missing shell expansion produces a 401; do not paste a live secret into an issue.

## Local service

The canonical local router is [`.linear-agent-bridge/agent-bridge.mjs`](.linear-agent-bridge/agent-bridge.mjs). It listens on `127.0.0.1:8788` and routes by Tunnel `Host` header. Antigravity launches `RUN_AGENT_PATH` with Python, Trae launches its configured CLI, Gemini supports headless mode or a Warp interactive launch, and ChatGPT saves the job for external handling. Configure `RUN_AGENT_PATH` to point to the actual deployed `run_agent.py` location; the repository keeps that Python file at its root.

## Documentation

See **[Architecture & Operations](docs/AGENT_BRIDGE_ARCHITECTURE_AND_OPERATIONS.md)** for design decisions, installation, OAuth flow, observed failures, security caveats, operational checks, and prioritized code-review findings.

---

Example organization · [yourdomain.com](https://yourdomain.com)

## npm agent commands

The root npm scripts support `antigravity`, `chatgpt`, `gemini`, `trae`, `mock`, or `all`:

```bash
npm ci                               # install all five workspaces from lockfile
npm run setup -- mock                # install one agent's workspace dependencies
npm run setup -- all                 # install all agent workspace dependencies
npm run dev -- mock                  # run one agent's Wrangler development server
npm run deploy -- mock               # deploy one Worker
npm run deploy -- all                # deploy all five Workers, sequentially
npm run types                        # generate Wrangler types for all five
npm run types -- mock                # generate Wrangler types for Mock only
```

For a single agent's Wrangler types use `npm run types -- mock` or `npm run types --workspace=linear-mock-worker`. The all-agent `dev` command is intentionally unsupported because each Wrangler development server stays running; start separate terminals for each agent instead. Deploying `all` requires all five Worker configurations, KV namespace IDs, domains, and secrets to be ready. `deploy` does not create DNS/KV or synchronize secrets. To sync secrets with root `.env`, use `bash scripts/with-env.sh worker mock sync-secrets` or substitute another agent name.
