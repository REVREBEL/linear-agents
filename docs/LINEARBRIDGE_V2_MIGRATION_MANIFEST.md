# LinearBridge v2 | Baseline, Inventory & Staged Migration Manifest

**Authority:** LinearBridge Architecture Document `4960a1d0f569` ([LinearBridge v2 architecture](https://linear.app/revrebel/document/linearbridge-v2-agent-centric-repository-structure-and-migration-4960a1d0f569)).  
**Tracking Issue:** [ABR-28](https://linear.app/revrebel/issue/ABR-28/implement-agent-centric-linearbridge-v2-layout-with-colocated-workers) / [GitHub PR #64](https://github.com/REVREBEL/linear-agents/issues/64).  
**Phase:** P0 Baseline & Manifest Specification.  
**Baseline Git Commit SHA:** `b5d4988b62b8a42424171f2b348a53e3a74b713c` (HEAD of `main`).  
**Date:** November 12, 2026.  

---

## 1. Executive Summary & Architectural Principles

LinearBridge v2 establishes an **agent-centric monorepo structure** where each coding agent colocates its edge Worker ingress, provider launcher, conversation/session adapters, callbacks, tests, and configuration inside its own dedicated directory (`agents/coding/<id>/`).

### Architectural Principles
1. **Agent as Primary Unit:** Each coding agent (`antigravity`, `chatgpt-cli`, `gemini`, `trae`, `mock`, `gemma`) owns its `worker/`, `conversations/`, `sessions/`, `scripts/`, `tests/`, and `agent.config.json`.
2. **Subpackage Runtime Separation:** Edge Cloudflare Worker runtimes (`worker/src/index.ts`, `wrangler.jsonc`) and Node.js/Python local runners (`scripts/launch.mjs`, `run_agent.py`) remain distinct subpackages with independent dependencies.
3. **Single Canonical Implementation of Shared Domains:** Core capabilities live in domain-specific root packages:
   - `jobs/` (job store, transitions, idempotency, outbox, progress events)
   - `conversations/` (Linear session ↔ provider ID mapping, lineage, recovery)
   - `memory/` (active task checkpoints, memU long-term memory integration)
   - `routing/` (host routing, SSH dispatch, trusted workspace resolution)
   - `integrations/` (Linear and GitHub API clients, OAuth verification)
   - `bridge/` (HTTP server, route handlers, orchestration engine)
4. **External Skills Governance:** Skills remain external in `REVREBEL/skills-library` governed by SKIL Zero-Index. No duplicate skill taxonomy or copied skill bodies exist in LinearBridge.
5. **Runtime Data Isolation:** Live state (`BRIDGE_DATA_DIR`, `.linear-agent/`, `linear-jobs/`) is strictly isolated from Git. No live job files or private keys are ever tracked or moved via `git mv`.
6. **Strict Identity Preservation:** Existing Cloudflare Worker deployment names, custom domains, KV namespaces (`LINEAR_DATA`), Durable Objects (`DELIVERY_COORDINATOR`), OAuth app credentials, Tunnel hostnames, and accepted issue/session IDs remain 100% byte-for-byte and contractually intact.
7. **Distinct Reviewer Workflow:** ChatGPT review-user identity and workflows live under `agents/bridge/reviewer/` and are strictly separated from `agents/coding/chatgpt-cli/`.

---

## 2. Baseline Environment & Test Suite Inventory

### Runtime Matrix
- **Node.js:** v24.19.0+
- **npm:** v11.x (workspaces enabled)
- **Python:** 3.12+ (Antigravity runner `run_agent.py`)
- **OS Environments:**
  - macOS Darwin (Local Mac bridge & LaunchAgent daemon)
  - Ubuntu Linux 24.04 LTS (Production bridge & systemd daemon)

### Pre-Migration Test Baseline
| Test Command | Test Target Glob / Suite | Tests Total | Passing | Skipped | Failing |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `npm run bridge:test` | `scripts/platform-scripts.test.mjs`<br>`linear-agent-bridge/*.test.mjs` | **90** | **89** | **1** | **0** |
| `npm run test:reliability` | `scripts/platform-scripts.test.mjs`<br>`scripts/oauth-errors.test.mjs`<br>`scripts/check-trae-callbacks.test.mjs`<br>`scripts/worker-webhook.test.mjs`<br>`scripts/macos/chatgpt-shortcuts/review-handoff.test.mjs`<br>`agents/coding/gemma/*.test.mjs`<br>`integrations/litellm/*.test.mjs`<br>`linear-agent-bridge/*.test.mjs` | **150** | **149** | **1** | **0** |

*Note: 1 test in `linear-agent-bridge/github-self-origin-dispatch.test.mjs` is intentionally skipped on macOS dev as it is a Linux CI-specific integration test.*

### Test Suite Breakdown
1. **Memory & Checkpoints:**
   - `linear-agent-bridge/active-task-memory.test.mjs` (6 tests)
   - `linear-agent-bridge/memu-memory.test.mjs` (7 tests)
2. **Launchers & Provider Sessions:**
   - `linear-agent-bridge/agent-launchers.test.mjs` (2 tests: Antigravity, Gemini)
   - `linear-agent-bridge/agy-conversation-state.test.mjs` (5 tests)
   - `linear-agent-bridge/agy-session-queue.test.mjs` (2 tests)
   - `linear-agent-bridge/chatgpt-opencode.test.mjs` (6 tests)
   - `linear-agent-bridge/mac-remote-runner.test.mjs` (5 tests: Trae)
   - `linear-agent-bridge/trae-completion.test.mjs` (2 tests)
   - `linear-agent-bridge/remote-trae-activity.test.mjs` (3 tests)
   - `agents/coding/gemma/inventory.test.mjs` (3 tests)
   - `agents/coding/gemma/dev-tools.test.mjs` (3 tests)
   - `agents/coding/gemma/provider-key.test.mjs` (2 tests)
   - `integrations/litellm/agent-runtime.test.mjs` (5 tests)
3. **Jobs & Ledger:**
   - `linear-agent-bridge/job-store.test.mjs` (8 tests)
   - `linear-agent-bridge/ordered-progress.test.mjs` (2 tests)
4. **Routing & SSH:**
   - `linear-agent-bridge/host-routing.test.mjs` (5 tests)
   - `linear-agent-bridge/ssh-dispatch.test.mjs` (1 test)
   - `linear-agent-bridge/linear-credentials.test.mjs` (1 test)
5. **Review Automation & GitHub Events:**
   - `linear-agent-bridge/github-events.test.mjs` (11 tests)
   - `linear-agent-bridge/github-self-origin-dispatch.test.mjs` (1 skipped)
   - `linear-agent-bridge/review-delivery.test.mjs` (3 tests)
   - `linear-agent-bridge/review-inbox-api.test.mjs` (1 test)
   - `linear-agent-bridge/review-inbox.test.mjs` (4 tests)
   - `linear-agent-bridge/review-linear-notifier.test.mjs` (4 tests)
   - `linear-agent-bridge/review-message-handoff.test.mjs` (5 tests)
   - `scripts/macos/chatgpt-shortcuts/review-handoff.test.mjs` (1 test)
6. **Platform Scripts & Edge Workers:**
   - `scripts/platform-scripts.test.mjs` (7 tests)
   - `scripts/oauth-errors.test.mjs` (1 test)
   - `scripts/check-trae-callbacks.test.mjs` (1 test)
   - `scripts/worker-webhook.test.mjs` (44 tests)

---

## 3. npm Workspaces & Package Topology

### Current (v1) Workspaces (`package.json`)
```json
{
  "workspaces": [
    "linear-antigravity-worker",
    "linear-chatgpt-worker",
    "linear-chatgpt-cli-worker",
    "linear-gemini-worker",
    "linear-trae-worker",
    "linear-mock-worker"
  ]
}
```

### Target (v2) Workspaces (`package.json`)
```json
{
  "workspaces": [
    "agents/coding/antigravity/worker",
    "agents/coding/chatgpt/worker",
    "agents/coding/chatgpt-cli/worker",
    "agents/coding/gemini/worker",
    "agents/coding/gemma/worker",
    "agents/coding/trae/worker",
    "agents/coding/mock/worker"
  ]
}
```

---

## 4. Transitive Import Graph & Module Boundaries

```
[Cloudflare Edge Workers]
  agents/coding/*/worker/src/index.ts
    └── shared/delivery-coordinator.ts
    └── shared/oauth-installation.ts
    └── shared/bridge-access-token.ts
    └── shared/github-app-homepage.ts
    └── shared/agent-location.ts
    └── shared/oauth-errors.ts

[Bridge Core Process]
  bridge/server/http-server.mjs (or linear-agent-bridge/agent-bridge.mjs shim)
    ├── integrations/linear/credentials.mjs
    ├── routing/host/host-routing.mjs
    ├── routing/ssh/ssh-dispatch.mjs
    ├── jobs/store/job-store.mjs
    ├── jobs/progress/ordered-progress.mjs
    ├── memory/short-term/active-task-memory.mjs
    ├── memory/short-term/github-task-memory.mjs
    ├── memory/long-term/memu-memory.mjs
    ├── integrations/github/events.mjs
    ├── agents/bridge/reviewer/workflows/*
    └── agents/coding/*/scripts/launch.mjs
          └── agents/coding/*/sessions/*
          └── agents/coding/*/conversations/*
```

---

## 5. Cloudflare Wrangler & Edge Infrastructure Inventory

| Agent / Worker Identifier | Cloudflare Worker Deployed Name | Custom Domain Route | KV Binding | Durable Object Binding | Shared Secret Binding |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **antigravity** | `linear-antigravity-agent` | `linear-antigravity.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **chatgpt** | `linear-chatgpt-agent` | `linear-chatgpt.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **chatgpt-cli** | `linear-chatgpt-cli-agent` | `linear-chatgpt-cli.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **gemini** | `linear-gemini-agent` | `linear-gemini.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **gemma** | `linear-gemma-agent` | `linear-gemma.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **trae** | `linear-trae-agent` | `linear-trae.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |
| **mock** | `linear-mock-agent` | `linear-mock.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` |

*Configuration Engine:* `scripts/render-wrangler.mjs` reads manifest and environment variables, generating ephemeral `wrangler.local.$.$RANDOM.jsonc` without mutating git state or leaking secrets.

---

## 6. Operating System Services & Daemons

### Ubuntu Linux (systemd)
- **Service Unit:** `agent-bridge.service` (`/etc/systemd/system/agent-bridge.service`)
- **Service Identity:** Dedicated non-login bridge service account (`bridge` / UID 1001)
- **Installer Script:** `scripts/linux/install-systemd.sh`
- **Control Wrapper:** `scripts/linux/bridge.sh` (`status`, `restart`, `load`, `unload`)
- **GitHub Event Publisher:** `scripts/linux/install-github-event-publisher.sh`, `scripts/linux/run-github-event-publisher.sh`
- **Sudoers Rule:** `/etc/sudoers.d/agent-bridge` granting passwordless `systemctl restart agent-bridge.service`

### macOS (LaunchAgent)
- **LaunchAgent Plist:** `com.revrebel.agent-bridge.plist` (`~/Library/LaunchAgents/`)
- **Installer Script:** `scripts/macos/install-launchagent.sh`
- **Control Wrapper:** `scripts/macos/bridge.sh` (`status`, `restart`, `load`, `unload`, `doctor`)
- **Remote Agent Runner:** `scripts/macos/remote-agent-runner.mjs`
- **ChatGPT Shortcuts Review Handoff:** `scripts/macos/chatgpt-shortcuts/review-handoff.mjs`

---

## 7. Continuous Integration Inventory

### GitHub Actions Workflow (`.github/workflows/worker-reliability.yml`)
- **Triggers:** Push to `main` and Pull Requests.
- **Path Filter (v1):** `linear-*-worker/**`, `shared/**`, `linear-agent-bridge/**`, `scripts/**`
- **Path Filter (v2):** `agents/**`, `bridge/**`, `jobs/**`, `conversations/**`, `memory/**`, `routing/**`, `integrations/**`, `shared/**`, `platforms/**`, `scripts/**`, `.github/workflows/**`
- **Steps:**
  1. `npm ci`
  2. `npm run types` / `npm run typecheck`
  3. `npm run bridge:test`
  4. `npm run test:reliability`

---

## 8. Bridge Runtime State & Ignore Pattern Ledger

### Git Ignore Invariants (`.gitignore`)
The following patterns isolate all live runtime state and secrets from source control:
- `.env`, `.env.local`, `.env.*.local`
- `.dev.vars`
- `.linear-agent/` (per-repo task inbox and outbox)
- `linear-jobs/`, `linear-jobs-interrupted/`
- `pids/`, `*.pid`, `*.pid.lock`
- `logs/`, `*.log`
- `wrangler.local.*.jsonc`

*Verification:* Zero live job data, OAuth refresh tokens, tunnel credentials, or private keys are stored in tracked repository files.

---

## 9. Comprehensive Old → New Path, Ownership & Dependency Matrix

| Current v1 Path | Target v2 Path | Domain Ownership | Responsibilities & Boundaries |
| :--- | :--- | :--- | :--- |
| **Worker Ingress** | | | |
| `linear-antigravity-worker/` | `agents/coding/antigravity/worker/` | Antigravity Ingress | Webhook HMAC verification, OAuth token exchange, DO deduplication |
| `linear-chatgpt-worker/` | `agents/coding/chatgpt/worker/` | ChatGPT Legacy Ingress | Legacy ChatGPT Webhook/OAuth ingress |
| `linear-chatgpt-cli-worker/` | `agents/coding/chatgpt-cli/worker/` | ChatGPT CLI Ingress | Dedicated CLI Worker endpoint and KV store |
| `linear-gemini-worker/` | `agents/coding/gemini/worker/` | Gemini Ingress | Gemini Webhook HMAC verification & OAuth token exchange |
| `linear-trae-worker/` | `agents/coding/trae/worker/` | Trae Ingress | Trae Webhook/OAuth ingress, Activity and progress callback proxy |
| `linear-mock-worker/` | `agents/coding/mock/worker/` | Mock Agent Ingress | Test and verification Worker harness |
| *(Already v2)* | `agents/coding/gemma/worker/` | Gemma Ingress | Isolated OpenRouter/Gemma Worker ingress |
| **Provider Scripts & Launchers** | | | |
| `linear-agent-bridge/agents/antigravity/scripts/launch.mjs` | `agents/coding/antigravity/scripts/launch.mjs` | Antigravity Runner | Spawns `run_agent.py`, manages sandbox, intercepts quota signals |
| `linear-agent-bridge/run_agent.py` | `agents/coding/antigravity/scripts/run_agent.py` | Antigravity Runner | Python AGY CLI runner with stream-json and linear progress |
| `linear-agent-bridge/agy-conversation-state.mjs` | `agents/coding/antigravity/conversations/state.mjs` | Antigravity Conversations | Discovers and persists AGY conversation ID per Linear session |
| `linear-agent-bridge/agy-session-queue.mjs` | `agents/coding/antigravity/sessions/queue.mjs` | Antigravity Sessions | Quota exhaustion handler, 2-hour backoff timer, exact session retry |
| `linear-agent-bridge/agents/chatgpt/scripts/launch.mjs` | `agents/coding/chatgpt-cli/scripts/launch.mjs` | ChatGPT CLI Runner | Spawns OpenCode CLI with user OAuth credentials |
| `linear-agent-bridge/agents/gemini/scripts/launch.mjs` | `agents/coding/gemini/scripts/launch.mjs` | Gemini Runner | Local Gemini CLI process launcher and argument validation |
| `linear-agent-bridge/agents/trae/scripts/launch.mjs` | `agents/coding/trae/scripts/launch.mjs` | Trae Runner | macOS Trae agent task file creator and SSH trigger |
| `linear-agent-bridge/agents/trae/scripts/complete.mjs` | `agents/coding/trae/scripts/complete.mjs` | Trae Runner | Trae session completion webhook sender |
| `linear-agent-bridge/remote-trae-activity.mjs` | `agents/coding/trae/sessions/remote-trae-activity.mjs` | Trae Progress | Authenticated Trae activity forwarder to Linear |
| **Review Automation** | | | |
| `linear-agent-bridge/review-inbox.mjs` | `agents/bridge/reviewer/workflows/review-inbox.mjs` | Reviewer Role | GitHub PR review inbox deduplication and claim ledger |
| `linear-agent-bridge/review-delivery.mjs` | `agents/bridge/reviewer/workflows/review-delivery.mjs` | Reviewer Role | Verified GitHub review delivery validation |
| `linear-agent-bridge/review-linear-notifier.mjs` | `agents/bridge/reviewer/workflows/review-linear-notifier.mjs` | Reviewer Role | Linear issue creation and updates for ChatGPT reviewer user |
| `linear-agent-bridge/review-message-handoff.mjs` | `agents/bridge/reviewer/workflows/review-message-handoff.mjs` | Reviewer Role | Dispatch of review prompts to macOS review harness |
| `linear-agent-bridge/github-task-memory.mjs` | `memory/short-term/github-task-memory.mjs` | Short-Term Memory | PR-level short term memory and review comment state |
| **Core Job Engine & Ledger** | | | |
| `linear-agent-bridge/job-store.mjs` | `jobs/store/job-store.mjs` | Job Ledger | Filesystem atomic job deduplication, states, idempotency |
| `linear-agent-bridge/ordered-progress.mjs` | `jobs/progress/ordered-progress.mjs` | Job Progress | Monotonic, bounded, redacted progress event publisher |
| `linear-agent-bridge/active-task-memory.mjs` | `memory/short-term/active-task-memory.mjs` | Short-Term Memory | Task checkpoint persistence, progress log, revision schema v2 |
| `linear-agent-bridge/memu-memory.mjs` | `memory/long-term/memu-memory.mjs` | Long-Term Memory | MemU recall preparation, provenance snapshots, promotion gate |
| `scripts/memu-promote.mjs` | `memory/long-term/memu-promote.mjs` | Long-Term Memory | MemU session promotion utility |
| **Routing & Infrastructure** | | | |
| `linear-agent-bridge/host-routing.mjs` | `routing/host/host-routing.mjs` | Host Routing | Host header-based agent selection and project route lookup |
| `linear-agent-bridge/ssh-dispatch.mjs` | `routing/ssh/ssh-dispatch.mjs` | SSH Routing | Fixed remote SSH runner dispatch with payload isolation |
| `linear-agent-bridge/routing.example.json` | `routing/config/routing.example.json` | Routing Config | Example project UUID to repository path routing map |
| **Integrations** | | | |
| `linear-agent-bridge/linear-credentials.mjs` | `integrations/linear/credentials.mjs` | Linear Integration | Worker OAuth access token cache and exchange |
| `linear-agent-bridge/github-events.mjs` | `integrations/github/events.mjs` | GitHub Integration | GitHub webhook payload sanitizer and PR comment classifier |
| `scripts/publish-github-events.mjs` | `integrations/github/publisher.mjs` | GitHub Integration | GitHub event polling and local bridge dispatcher |
| **Bridge Core & Server** | | | |
| `linear-agent-bridge/agent-bridge.mjs` | `bridge/server/http-server.mjs`<br>*(re-exported via shim)* | Bridge Server | HTTP server, auth verification, route dispatch, error handlers |
| `linear-agent-bridge/start-bridge.sh` | `bridge/server/start-bridge.sh` | Bridge Server | Process launcher wrapper |
| **Shared Contracts & Platform Support** | | | |
| `shared/*` | `shared/*` | Shared Edge/Node | Edge-safe delivery coordinator, OAuth installation, types |
| `scripts/linux/*` | `platforms/linux/*` | Linux Platform | systemd service definitions, installers, control scripts |
| `scripts/macos/*` | `platforms/macos/*` | macOS Platform | LaunchAgent plist definitions, installers, control scripts |

---

## 10. Staged Migration Plan & Rollback Strategy

The migration proceeds across six strictly sequenced, non-destructive phases:

### Phase P0: Baseline & Manifest (First PR)
- **Objective:** Establish the comprehensive baseline document and verify test integrity before code moves.
- **Verification:** Run `npm run bridge:test` (90 tests) and `npm run test:reliability` (150 tests).
- **Rollback:** Single-commit revert of documentation files.

### Phase P1: Build & Compatibility Engine (Second PR)
- **Objective:** Implement provider-neutral agent manifest registry (`agents/registry/agent-manifest.mjs`), update script lookups (`render-wrangler.mjs`, `workspace-command.mjs`, `with-env.sh`, `setup-kv.mjs`, `workspace-typecheck.mjs`), update CI glob filters, and implement recursive test discovery.
- **Verification:** All scripts resolve both legacy and new worker paths; 150 tests pass.
- **Rollback:** Revert PR #2; scripts fall back to static list.

### Phase P2: Domain Modules Extraction (Small PRs)
- **Objective:** Move tested domain modules into `integrations/`, `routing/`, `jobs/`, `memory/`, `conversations/` while maintaining re-export compatibility shims in `linear-agent-bridge/`.
- **Verification:** Import cycle checks; 150 tests pass via both legacy shims and new module paths.
- **Rollback:** Revert module PR; compatibility shims ensure zero caller disruption.

### Phase P3: Agent Packages & Worker Colocation (One PR per Agent)
- **Objective:** Colocate each agent's worker, scripts, sessions, conversations, and tests under `agents/coding/<id>/` and `agents/bridge/reviewer/`. Update root `package.json` workspaces.
- **Verification:** `npm run typecheck`, `npm run types`, `npm run bridge:test`, `npm run test:reliability`.
- **Rollback:** Revert specific agent PR; restore legacy workspace.

### Phase P4: Bridge Decomposition (Fifth PR)
- **Objective:** Decompose `linear-agent-bridge/agent-bridge.mjs` (~93 KB) into `bridge/{server,handlers,orchestration,config}` with a stable entrypoint shim.
- **Verification:** Exact HTTP contract testing on `/jobs`, `/complete`, `/health`, `/github-events`.
- **Rollback:** Revert to monolithic `agent-bridge.mjs`.

### Phase P5: Cutover, Docs & Shim Retirement (Final PRs)
- **Objective:** Following separate human authorization, verify live bridge endpoints across Ubuntu and macOS, update runbooks, and retire compatibility shims.
- **Verification:** End-to-end OAuth and webhook delivery verification on all 6 worker domains.
- **Rollback:** Restore compatibility shims if any unmigrated consumer remains.

---

## 11. Invariant Checklist & Sign-Off Gate

- [x] Baseline SHA recorded: `b5d4988b62b8a42424171f2b348a53e3a74b713c`
- [x] Zero live runtime data, task files, or secret keys included
- [x] Pre-move test count verified (150 reliability tests, 90 bridge tests)
- [x] Cloudflare Worker identities and custom domains mapped 1:1
- [x] Non-destructive rollback plans defined for all stages
- [x] External skills library boundary respected
