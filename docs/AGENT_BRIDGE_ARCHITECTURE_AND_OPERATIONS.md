> **Current implementation note (2026-10-27):** This document contains a historical code-audit snapshot, including retired paths and four-Worker assumptions. For current operational commands and implementation boundaries, read [AGENTS.md](../AGENTS.md) and the current source files. The repository now has five Workers (including Mock), and the local router and Python runner live under `linear-agent-bridge/`. The bridge includes issue-completed inbox cleanup and a persisted AGY quota-retry path; neither has been verified by a production exhaustion simulation. Historical findings below remain as audit history, not an assertion of current behavior.

# REVREBEL Linear Agent Bridge
## Architecture, construction notes, operations and code audit

**Snapshot:** 2026-10-20 (updated after live router was committed)  
**Repository:** https://github.com/REVREBEL/linear-agents  
**Review scope:** root bridge and Python runners, four Worker sources and Wrangler configurations, root README, source tree. This is a static source review, not a production environment inspection or proof of successful end-to-end runs.

## Purpose

The project makes Linear application agents assignable and allows a verified Agent Session webhook to start local execution on a Mac. Each Linear app has a Cloudflare Worker and separate OAuth installation credentials. Cloudflare Tunnel exposes a local receiver without opening a public inbound port. Workers store installation state in Cloudflare KV and emit Linear Agent Activities using the app's OAuth access token.

A completion callback tells Linear that the **session** finished. It does **not** automatically change the **issue status** to Done.

## Logical architecture

```text
                          LINEAR
                 app delegation / webhook
                             |
                  POST /webhook (signed)
                             |
          linear-<agent>.yourdomain.com  [Worker]
                |                  |
         KV: LINEAR_DATA     Linear GraphQL:
         OAuth install       agentActivityCreate
         dedupe IDs             initial thought
         session→org mapping     terminal response/error
                |
         completion instruction added to prompt
                |
         POST BRIDGE_URL (/jobs) with Bearer secret
                |
        <agent>-agent.yourdomain.com [Cloudflare Tunnel]
                |
              127.0.0.1:8788
                |
         local listener saves/dispatches job
                |
        Antigravity | Trae | Gemini | ChatGPT file
                |
       POST Worker /complete (Bearer secret)
                |
            final Agent Activity
```

The Cloudflare custom-domain host (`linear-*.yourdomain.com`) must point at the Worker, **not** the Tunnel. The Tunnel host (`*-agent.yourdomain.com`) points at the local service.

## Agent deployment matrix

| App | Worker name | Public Worker | Tunnel job endpoint |
|---|---|---|---|
| Antigravity | `linear-antigravity-agent` | `https://linear-antigravity.yourdomain.com` | `https://antigravity-agent.yourdomain.com/jobs` |
| Trae | `linear-trae-agent` | `https://linear-trae.yourdomain.com` | `https://trae-agent.yourdomain.com/jobs` |
| Gemini CLI | `linear-gemini-agent` | `https://linear-gemini.yourdomain.com` | `https://gemini-agent.yourdomain.com/jobs` |
| ChatGPT | `linear-chatgpt-agent` | `https://linear-chatgpt.yourdomain.com` | `https://chatgpt-agent.yourdomain.com/jobs` |

Each Worker has a distinct KV namespace ID, but the binding key is always `LINEAR_DATA`. Workers currently duplicate exactly the same `src/index.ts` source, so fixes must be synchronized manually.

## Repository contents and current state

- `linear-{antigravity,trae,gemini,chatgpt}-worker/src/index.ts`: generic OAuth/webhook/completion Worker, duplicated across four folders.
- `linear-*/wrangler.jsonc`: individual Worker name, KV binding, callback URL, public bridge endpoint.
- `run_agent.py`: Antigravity CLI runner; also tries to create Linear Agent Activities with locally configured token or API key.
- `.linear-agent-bridge/agent-bridge.mjs`: the committed canonical hostname-based router for Antigravity, Trae, Gemini and ChatGPT.
- `.linear-agent-bridge/.trae/`: the Trae session-start hook integration.
- The superseded root-level `bridge_daemon.py` and `chatgpt-bridge.mjs` were removed in repository cleanup; their history remains in Git.

Use `.linear-agent-bridge/agent-bridge.mjs` as the sole intended listener on port 8788. Ensure the LaunchAgent points to the deployed copy and that `RUN_AGENT_PATH` resolves to the Python runner.

## How OAuth is constructed

1. `GET /install` checks `LINEAR_CLIENT_ID`, `LINEAR_REDIRECT_URI` and `LINEAR_SCOPES`.
2. The Worker creates an unpredictable OAuth state value and writes `oauth-state:<state>` in `LINEAR_DATA` with a 600-second TTL.
3. The browser redirects to `https://linear.app/oauth/authorize` with `actor=app`, the configured scopes, state, and exact redirect URI.
4. Linear returns to `GET /oauth/callback?code=...&state=...`.
5. The Worker validates and consumes the state, exchanges the code at Linear's OAuth token endpoint, resolves organization identity via GraphQL, and writes `installation:<organizationId>` in KV.
6. Later requests use the stored app token, optionally refreshing it when near expiry.

**OAuth lessons:** The callback URI must match the registered Linear app exactly. The `LINEAR_DATA` binding name must match the TypeScript code, even when the KV namespace itself is named differently. A missing KV binding previously caused `Cannot read properties of undefined (reading 'put')`. An intermittent `upstream connect ... connection timeout` alone does not prove whether the Worker, browser, proxy or outbound token exchange caused the failure. Use request-specific Worker logs and test `/health`, `/install`, and `/oauth/callback` separately.

## Webhook lifecycle

1. Linear POSTs to `/webhook`.
2. The Worker checks the `linear-signature` HMAC against the raw request body using `LINEAR_WEBHOOK_SECRET`.
3. It validates `organizationId`, deduplicates on the `linear-delivery` header if present, and looks up the installation.
4. For `AgentSessionEvent` action `create` or `created`, it extracts the session ID (including `payload.data.id`) and sends a `thought` Agent Activity.
5. If a usable prompt exists, it stores `agent-session:<sessionId>` → organization in KV for 14 days.
6. It appends the agent-specific `/complete` curl instruction to `payload.data.promptContext` and retains the raw original payload under `payload.original`.
7. It schedules a `POST /jobs` to `BRIDGE_URL` with an Authorization bearer token, returning HTTP 200 to Linear without waiting for local execution.

**Key discovery:** A webhook HTTP 200/202 is not a Linear Agent Activity. Linear expects an early Agent Activity, sent via `agentActivityCreate` and the app's OAuth token. A personal `LINEAR_API_KEY` is not interchangeable with an OAuth app token for that mutation.

**Dedupe discovery:** `payload.webhookId` can identify a webhook configuration rather than a unique delivery. Use the `linear-delivery` header, but see the review note below about the unsafe fallback and when deduplication is recorded.

## Local job contract

```http
POST /jobs
Authorization: Bearer <BRIDGE_SHARED_SECRET>
Content-Type: application/json
X-Linear-Webhook-Id: <delivery-id>
```

The Worker forwards a JSON envelope including `organizationId`, `agentSessionId`, `completionUrl`, `payload.data.promptContext` (amended), and `payload.original` (original Linear event). The local bridge should validate authorization **before** persisting or dispatching a job, return quickly, and make execution errors observable.

The committed unified router selects the runtime using the hostname: `antigravity-agent.yourdomain.com`, `trae-agent.yourdomain.com`, `gemini-agent.yourdomain.com`, or `chatgpt-agent.yourdomain.com`. Its LaunchAgent configuration and execution must still be validated against the live Mac; the router itself is committed.

On a local macOS LaunchAgent use an explicit Python venv binary, CLI executable paths and repository workspaces. Validate the `GEMINI_BIN`, `TRAE_BIN`, their arguments, authentication and whether the command blocks or merely opens an IDE session. A successful process spawn is not proof that the work completed.

## Completion contract

```bash
curl -X POST "https://linear-trae.yourdomain.com/complete" \
  -H "Authorization: Bearer $BRIDGE_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agentSessionId":"ACTUAL_SESSION_ID","status":"completed"}'
```

Valid intended statuses: `completed` → Linear `response` activity; `failed`/`error` → Linear `error` activity. The Worker resolves the organization from the session mapping (or request-provided organization ID) and uses the app OAuth installation to call `agentActivityCreate`.

The current Worker adds **this instruction to forwarded task context**, not to the persistent Linear issue description and not to globally shared Linear agent instructions. This is why unrelated agents should not receive a global completion requirement.

**Critical precondition:** the literal `$BRIDGE_SHARED_SECRET` expands only if the agent's execution environment contains that variable. If unavailable, the endpoint returns 401. Never embed a shared credential in issue text, comments or logs. Replace this with scoped one-time completion credentials when hardening.

**Separate issue workflow:** The current Worker does not call Linear's issue-status mutation. The human/agent must separately set the issue to Done when appropriate. A finished Agent Session and a Done issue are independent conditions.

## Configuration reference

Each `linear-*/wrangler.jsonc` uses:

```jsonc
"kv_namespaces": [{ "binding": "LINEAR_DATA", "id": "AGENT_SPECIFIC_NAMESPACE_ID" }],
"vars": {
  "SERVICE_NAME": "linear-trae-agent",
  "LINEAR_REDIRECT_URI": "https://linear-trae.yourdomain.com/oauth/callback",
  "LINEAR_SCOPES": "read,write,app:assignable,app:mentionable",
  "BRIDGE_URL": "https://trae-agent.yourdomain.com/jobs"
}
```

Secrets, created in each Worker directory with `npx wrangler secret put NAME`: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, and `BRIDGE_SHARED_SECRET`. Confirm the CLI is operating against the right Worker directory/configuration. Never put secret values in `wrangler.jsonc`, documentation, issues, health output or Git history.

The same `BRIDGE_SHARED_SECRET` currently authenticates both Worker→bridge job dispatch and agent→Worker completion callbacks. This is functional but excessive privilege.

## Deployment and verification

From the desired `linear-<agent>-worker/` directory:

```bash
npm install
npx wrangler deploy
npx wrangler tail
```

From another terminal:

```bash
curl -i https://linear-trae.yourdomain.com/health
curl -i https://linear-trae.yourdomain.com/install
curl -i https://linear-trae.yourdomain.com/oauth/callback
curl -i https://trae-agent.yourdomain.com/health
```

Expected: Worker health HTTP 200, install HTTP 302 to Linear with correct app client and callback, bare callback HTTP 400 missing code/state, Tunnel health HTTP 200 only when local listener and tunnel are online. A valid OAuth install and an assigned issue should generate fresh logs for verification, acknowledgment and forwarding. The final `/complete` call should result in a `response` or `error` Agent Activity, not simply a 2xx bridge acknowledgement.

Earlier tests created in Linear: `REV-81` Antigravity, `REV-82` ChatGPT, `REV-83` Trae, and `REV-84` Gemini. Creation/delegation of these issues was confirmed; **full acknowledgment and completion from each local runtime were not verified in this review**.

## Historical failures and fixes

| Symptom | Finding / remedy |
|---|---|
| `/install` crashes reading `.put` | KV binding not exposed as `LINEAR_DATA` |
| OAuth callback fails after Linear authorize | Inspect callback-specific Worker logs, secret match, exact redirect URI and upstream response; do not guess from an old log |
| Initial session says agent did not respond | Early `thought` Agent Activity required, with app OAuth token |
| Later Agent Session events skipped | Do not dedupe solely by `payload.webhookId`; prefer unique `linear-delivery` |
| Personal API key rejected by `agentActivityCreate` | App OAuth access token is required |
| Python `requests` missing | Configure LaunchAgent to use the Python venv interpreter |
| Antigravity localharness missing | Resolve executable and configure harness path/compatible runtime |
| CLI gets only part of a prompt | Preserve `{{PROMPT}}` as a **single** process argument when splitting templates |
| Old local router leaked secrets from `/health` | Remove actual secrets from diagnostic responses entirely |
| ChatGPT route unexpectedly launched Antigravity | The intended unified router's ChatGPT route should save the job only; checked-in legacy bridge does not implement that |
| Success reported before local job runs | Worker currently responds once forwarding is scheduled, not after execution; follow logs and completion callback |

## Repository audit and open items

The following observations are from source on `main` at review time. They are not automatically fixed by adding this document.

### P0 / blocking or security-sensitive

1. **Unified router now committed (resolved):** `.linear-agent-bridge/agent-bridge.mjs` contains the multi-agent hostname router. The older receivers have been deleted. Still verify the active LaunchAgent points at this version and that `RUN_AGENT_PATH` references an existing `run_agent.py` (the default path is inside `.linear-agent-bridge/`, while the repository's runner is currently at the root).
2. **Completion secret reachability:** Worker injects literal `$BRIDGE_SHARED_SECRET` into CLI task text, but no committed setup ensures that environment variable is available inside every executing agent. Terminal callback can silently fail with 401. Use an authorized, short-lived per-session token instead of exposing a reusable bridge secret broadly.
3. **Legacy runner auth contradiction:** `run_agent.py` attempts `agentActivityCreate` with `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN`; the former was rejected by Linear and the latter is not automatically propagated from Worker KV. Choose Worker `/complete` as canonical terminal activity path; retire duplicate local mutations.
4. **Acknowledged delivery without execution guarantee:** Worker sends initial `thought` then schedules dispatch using `ctx.waitUntil`. It returns `forwarded: true` before verifying Tunnel/local acceptance, and catches/logs forwarding failures without retry or a failed Agent Activity. Add durable queue/retry/dead-letter behavior and honest response diagnostics.

### P1 / correctness and durability

5. **Dedupe recorded too early:** Worker writes dedupe KV before checking installation, attempting early activity, and forwarding. A transient failure or missing install can consume the delivery and cause a retry to be treated as duplicate. Move dedupe finalization to successful processing with an explicit in-progress/failed state.
6. **Fallback dedupe identifier unsafe:** Worker falls back from `linear-delivery` to `payload.webhookId`, which is not a per-delivery ID. If header missing, use a safer event-scoped fallback or fail explicitly.
7. **Event filtering:** Worker may forward any webhook with `promptContext`, not strictly initial `AgentSessionEvent` actions. Local runtime should reject duplicate/non-execution events; audit event/action predicates.
8. **Completion idempotency:** `/complete` has no per-session terminal-state guard; repeated calls can create repeated Linear activities. Persist and enforce terminal status.
9. **Status validation:** Any status other than `failed` or `error` currently maps to success. Explicitly allow `completed`/`failed` and reject unknown values.
10. **Trusting caller-provided organization ID:** `/complete` accepts `organizationId` override instead of requiring it to match the session mapping. Bind completion authorization and lookup to the stored session.
11. **KV eventual consistency:** State, delivery tracking and terminal events rely on KV; concurrency and immediate cross-location reads may merit Durable Objects or D1.
12. **Four duplicated Worker sources:** Shared code can diverge accidentally. Extract a common implementation or introduce an automated checksum/diff test.

### P2 / maintenance and repository hygiene

13. All four per-Worker READMEs are stale Antigravity starter text. They reference `ANTIGRAVITY_BRIDGE_URL` even though Worker source expects `BRIDGE_URL`, and describe obsolete `workers.dev` default URLs. Refresh after runtime consolidation.
14. `README.md` was a generic REVREBEL template and had not documented installation, real routes or deployment boundaries.
15. The root `.gitignore` does not explicitly ignore `.dev.vars`, `.venv/`, `linear-jobs/`, or `.wrangler/`; some Worker-local ignores cover some of these, but add repo-wide protection.
16. The committed generated `worker-configuration.d.ts` files are very large; decide whether to regenerate instead of hand-maintaining and keep type contracts in sync.
17. The root has no integrated test suite or CI for webhook signatures, dedupe, initial session acknowledgment, completion auth, hostname routing, CLI argument integrity, and duplicate delivery.
18. Audit `/health` and logs for sensitive information; the committed local router reports booleans for secret presence rather than secret contents, but logs and saved job payloads can still contain sensitive task context. Restrict operational diagnostics where practical.

## Recommended remediation order

1. **Router committed and legacy receivers removed.** Next, add a sanitized LaunchAgent example and verify `RUN_AGENT_PATH`, the Trae hook and CLI paths against the live host.
2. Replace reusable shared-secret completion with scoped short-lived session authorization, then add explicit terminal-status validation and idempotency.
3. Fix Worker event selection, dedupe transaction semantics and retry/error reporting.
4. Consolidate the four Worker sources, add tests and a deploy matrix in CI.
5. Align per-Worker READMEs, ignores, and sample configs with the actual deployment.

## Safety and maintenance principles

Keep app OAuth credentials in Worker secrets and KV; do not expose them to the Mac bridge. Use random secrets, rotate after exposure and avoid sharing terminal credentials with unrelated tools. Bind the listener to `127.0.0.1`, not to a public local interface; let Tunnel carry inbound traffic. Do not mistake a successful HTTP response, file write or CLI spawn for work completion. Keep session completion, issue workflow and code-validation statuses distinct.

## Source-of-truth files

- `linear-trae-worker/src/index.ts` (duplicated in the other three Workers)
- `linear-*/wrangler.jsonc`
- `.linear-agent-bridge/agent-bridge.mjs` and `.linear-agent-bridge/.trae/` session hooks
- `run_agent.py` (Antigravity runner)

**Cleanup record:** Removed `bridge_daemon.py` and `chatgpt-bridge.mjs` after confirming the canonical router replaced their receiver roles. Retained `run_agent.py` because `startAntigravity()` still launches a Python runner. No live Worker, router, Python runner or hook behavior was altered during cleanup.

This document supersedes earlier conversation-only architecture notes where their assumptions conflict with the actual repository snapshot.
