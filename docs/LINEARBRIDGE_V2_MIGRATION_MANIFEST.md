# LinearBridge v2 | Baseline, Inventory & Staged Migration Manifest

**Authority:** LinearBridge Architecture Document `4960a1d0f569` ([LinearBridge v2 architecture](https://linear.app/revrebel/document/linearbridge-v2-agent-centric-repository-structure-and-migration-4960a1d0f569)).  
**Tracking Issue:** [ABR-28](https://linear.app/revrebel/issue/ABR-28/implement-agent-centric-linearbridge-v2-layout-with-colocated-workers) / [GitHub PR #107](https://github.com/REVREBEL/linear-agents/pull/107).  
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
5. **Runtime Data Isolation:** Live state (`BRIDGE_DATA_DIR`, `.linear-agent/`, `linear-jobs/`, `linear-jobs-interrupted/`) is strictly isolated from Git via root `.gitignore` and dynamic per-repository `.git/info/exclude`. No live job files or private keys are ever tracked or moved via `git mv`.
6. **Strict Identity Preservation:** Existing Cloudflare Worker deployment names, custom domains, KV namespaces (`LINEAR_DATA`), Durable Objects (`DELIVERY_COORDINATOR`), OAuth app credentials, Tunnel hostnames, and accepted issue/session IDs remain 100% byte-for-byte and contractually intact.
7. **Distinct Reviewer Workflow:** ChatGPT review-user identity and workflows live under `agents/bridge/reviewer/` and are strictly separated from `agents/coding/chatgpt-cli/`.

---

## 2. Baseline Environment & Test Suite Inventory

### Runtime Matrix
- **Node.js:** `26.13.0` (pinned via root `package.json` Volta block and CI workflow; compatible with Node.js v24.19.0+)
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

#### Bridge Suite (`npm run bridge:test` — 90 tests total, 89 passed, 1 skipped)
1. **Platform Scripts:**
   - `scripts/platform-scripts.test.mjs` (10 tests: syntax, launcher selection, service inspection, KV setup)
2. **Memory & Checkpoints:**
   - `linear-agent-bridge/active-task-memory.test.mjs` (6 tests: persistence, serialization, progress events, schema v2, expiration)
   - `linear-agent-bridge/memu-memory.test.mjs` (7 tests: compact recall, format fallback, timeout handling, promotion gate)
3. **Launchers & Provider Sessions:**
   - `linear-agent-bridge/agent-launchers.test.mjs` (2 tests: Antigravity, Gemini launcher boundary)
   - `linear-agent-bridge/agy-conversation-state.test.mjs` (3 tests: conversation discovery, resumption flag, recovery provenance)
   - `linear-agent-bridge/agy-session-queue.test.mjs` (2 tests: sequential execution, error isolation)
   - `linear-agent-bridge/chatgpt-opencode.test.mjs` (6 tests: OAuth token handoff, daemon account inheritance, stream extraction, progress filtering)
   - `linear-agent-bridge/mac-remote-runner.test.mjs` (5 tests: workspace resolution, traversal rejection, symlink checks, Git exclude, cleanup)
   - `linear-agent-bridge/remote-trae-activity.test.mjs` (3 tests: authenticated activity forwarder, tunnel host validation, URL origin checks)
   - `linear-agent-bridge/trae-completion.test.mjs` (2 tests: token forwarding, ambiguous status rejection)
4. **Jobs & Ledger:**
   - `linear-agent-bridge/job-store.test.mjs` (6 tests: atomic claims, transition serialization, ambiguous reconciliation, session matching, workspace rotation)
   - `linear-agent-bridge/ordered-progress.test.mjs` (2 tests: monotonic ordering, resilient checkpoint writes)
5. **Routing & SSH:**
   - `linear-agent-bridge/host-routing.test.mjs` (5 tests: backward-compatibility fallback, macOS Trae route, root override, remote scope, shell safety)
   - `linear-agent-bridge/ssh-dispatch.test.mjs` (1 test: payload isolation)
   - `linear-agent-bridge/linear-credentials.test.mjs` (2 tests: credential isolation, access token caching)
6. **Review Automation & GitHub Events:**
   - `linear-agent-bridge/github-events.test.mjs` (12 tests: payload sanitization, PR link validation, event journal, review routing, sender checking)
   - `linear-agent-bridge/github-self-origin-dispatch.test.mjs` (1 skipped on macOS: Linux CI self-origin dispatch)
   - `linear-agent-bridge/review-delivery.test.mjs` (3 tests: verified review evidence, stale PR rejection, publication requirement)
   - `linear-agent-bridge/review-inbox-api.test.mjs` (1 test: authenticated reviewer claim)
   - `linear-agent-bridge/review-inbox.test.mjs` (3 tests: role isolation, duplicate rejection, serialized outcomes)
   - `linear-agent-bridge/review-linear-notifier.test.mjs` (4 tests: PR UUID stability, issue assignment, updates, missing user refusal)
   - `linear-agent-bridge/review-message-handoff.test.mjs` (4 tests: fixed runner dispatch, prompt-only handoff, double-submission suppression, EPIPE safety)

#### Additional Reliability Suite Tests (`npm run test:reliability` — +60 tests, 150 total)
1. **Edge Workers & Webhooks:**
   - `scripts/worker-webhook.test.mjs` (38 tests: Webhook HMAC verification, DO deduplication, alarm replay, payload freshness, Agent Location routing across all workers)
   - `scripts/oauth-errors.test.mjs` (4 tests: structured OAuth error reporting)
   - `scripts/check-trae-callbacks.test.mjs` (3 tests: Trae callback route validation)
   - `scripts/macos/chatgpt-shortcuts/review-handoff.test.mjs` (2 tests: macOS review handoff workflow)
2. **Gemma & LiteLLM Isolated Runtime:**
   - `agents/coding/gemma/inventory.test.mjs` (3 tests: task checkout, isolated fake filesystem, read-only tools)
   - `agents/coding/gemma/dev-tools.test.mjs` (3 tests: model selection, input safety, path traversal prevention)
   - `agents/coding/gemma/provider-key.test.mjs` (4 tests: scoped OpenRouter key, secret isolation)
   - `integrations/litellm/agent-runtime.test.mjs` (3 tests: client key loading, official SDK moves, rate limits & step exhaustion)

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

| Agent / Worker Identifier | Cloudflare Worker Deployed Name | Custom Domain Route(s) | KV Binding | Durable Object Binding | Shared Secret Binding | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **antigravity** | `linear-antigravity-agent` | `linear-antigravity.<DOMAIN>`<br>`github-antigravity.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Primary coding agent with dual Linear + GitHub custom domains |
| **chatgpt** | `linear-chatgpt-agent` | `linear-chatgpt.<DOMAIN>`<br>`github-chatgpt.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Legacy ChatGPT worker with dual Linear + GitHub custom domains |
| **chatgpt-cli** | `linear-chatgpt-agent` | `linear-chatgpt-cli.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Shares deployed worker name & Linear OAuth app identity with `chatgpt`; distinct KV namespace ID and CLI route |
| **gemini** | `linear-gemini-agent` | `linear-gemini.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Gemini coding agent ingress |
| **gemma** | `linear-gemma-agent` | `linear-gemma.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Isolated OpenRouter/Gemma evaluation ingress |
| **trae** | `linear-trae-agent` | `linear-trae.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Trae coding agent with macOS remote dispatch |
| **mock** | `linear-mock-agent` | `linear-mock.<DOMAIN>` | `LINEAR_DATA` | `DELIVERY_COORDINATOR` | `BRIDGE_SHARED_SECRET` | Test and verification harness |

### Configuration Engine (`scripts/render-wrangler.mjs`)
- **Inputs:** Accepts CLI arguments `[agent, outPath]`, reads environment variables from root `.env` (`DOMAIN`, `${AGENT}_PREFIX`, `${AGENT}_KV_NAMESPACE_ID`), and parses the static template `wrangler.jsonc` in the target worker directory.
- **Output:** Generates an ephemeral, untracked `wrangler.local.$.$RANDOM.jsonc` file with restrictive file permissions (`mode: 0o600`), replacing environment placeholders with concrete deployment IDs without mutating tracked repository templates.
- **Phase P1 Evolution:** Directory lookup will be migrated from hardcoded ternary/switch paths to dynamic manifest resolution backed by the versioned Agent Registry (`agents/registry.json` conforming to `agents/registry.schema.json`, tracked in PR #109).

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
- **Trigger Events:**
  - `pull_request` (scoped by path filters)
  - `workflow_dispatch` (manual dispatch)
- **Path Filter (v1 Current):**
  - `linear-*-worker/**`
  - `linear-agent-bridge/**`
  - `agents/**`
  - `integrations/**`
  - `shared/**`
  - `scripts/**`
  - `package.json`
  - `package-lock.json`
  - `.github/workflows/worker-reliability.yml`
- **Path Filter (v2 Target):**
  - `agents/**`
  - `bridge/**`
  - `jobs/**`
  - `conversations/**`
  - `memory/**`
  - `routing/**`
  - `integrations/**`
  - `shared/**`
  - `platforms/**`
  - `scripts/**`
  - `package.json`
  - `package-lock.json`
  - `.github/workflows/worker-reliability.yml`
- **Pipeline Steps:**
  1. `actions/checkout@v7`
  2. `actions/setup-node@v7` (Node.js version `26`, npm cache)
  3. `npm ci`
  4. Generate runtime types: `npm run types`
  5. Check Worker TypeScript: `npm run typecheck`
  6. Run reliability and bridge regression tests: `npm run test:reliability`
  7. Validate isolated Gemma SDK dependency and test package

---

## 8. Bridge Runtime State & Ignore Pattern Ledger

### Git Ignore Invariants
Isolation of live runtime state, task payloads, and secrets from Git is enforced through two complementary mechanisms:

1. **Root `.gitignore` Rules (Tracked in Repository):**
   - Environment and secret files: `.env`, `.env.*`, `*.env`, `.dev.vars`, `.dev.vars.*` (except `.env.example`, `.dev.vars.example`)
   - Bridge runtime ledgers & interrupted job storage: `linear-jobs/`, `linear-jobs-interrupted/`, `.linear-agent-bridge/linear-jobs/`
   - Per-repo task directories: `.linear-agent/`
   - Process IDs & locks: `pids`, `pids/`, `*.pid`, `*.pid.lock`
   - Log files: `logs/`, `*.log`, `.linear-agent-bridge/trae-hook-events.log`
   - Ephemeral configs: `wrangler.local.*.jsonc`, `**/worker-configuration.d.ts`
   - Trae runtime prompt files: `.linear-agent-bridge/trae-pending-prompt.txt`, `.linear-agent-bridge/trae-consumed-prompts/`
   - Private routing maps: `linear-agent-bridge/routing.json`

2. **Dynamic Per-Repository Excludes (`.git/info/exclude`):**
   - When the agent bridge runner executes tasks in local or remote repository worktrees, it dynamically ensures `.linear-agent/` and `.env.linear-bridge` are written to the target worktree's `.git/info/exclude` prior to task file creation, preventing task payload staging even if the target repository lacks a root rule.

*Verification:* Zero live job data, OAuth refresh tokens, tunnel credentials, or private keys are stored in tracked repository files.

---

## 9. Comprehensive Old → New Path, Ownership & Dependency Matrix

| Current v1 Path | Target v2 Path | Domain Ownership | Responsibilities & Boundaries |
| :--- | :--- | :--- | :--- |
| **Worker Ingress** | | | |
| `linear-antigravity-worker/` | `agents/coding/antigravity/worker/` | Antigravity Ingress | Webhook HMAC verification, OAuth token exchange, DO deduplication, dual custom domains (`linear-antigravity.*`, `github-antigravity.*`) |
| `linear-chatgpt-worker/` | `agents/coding/chatgpt/worker/` | ChatGPT Legacy Ingress | Legacy ChatGPT Webhook/OAuth ingress, dual custom domains (`linear-chatgpt.*`, `github-chatgpt.*`) |
| `linear-chatgpt-cli-worker/` | `agents/coding/chatgpt-cli/worker/` | ChatGPT CLI Ingress | Dedicated CLI Worker endpoint and KV store (`linear-chatgpt-cli.*`) |
| `linear-gemini-worker/` | `agents/coding/gemini/worker/` | Gemini Ingress | Gemini Webhook HMAC verification & OAuth token exchange (`linear-gemini.*`) |
| `linear-trae-worker/` | `agents/coding/trae/worker/` | Trae Ingress | Trae Webhook/OAuth ingress, Activity and progress callback proxy (`linear-trae.*`) |
| `linear-mock-worker/` | `agents/coding/mock/worker/` | Mock Agent Ingress | Test and verification Worker harness (`linear-mock.*`) |
| *(Already v2)* | `agents/coding/gemma/worker/` | Gemma Ingress | Isolated OpenRouter/Gemma Worker ingress (`linear-gemma.*`) |
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
- **Objective:** Establish the comprehensive baseline document, audit Git ignore patterns, and verify test suite integrity before code moves.
- **Verification:** Run `npm run bridge:test` (90 tests) and `npm run test:reliability` (150 tests).
- **Rollback:** Single-commit revert of documentation files.

### Phase P1: Build & Compatibility Engine (Second PR)
- **Objective:** Integrate the versioned Agent Registry (`agents/registry.json` conforming to `agents/registry.schema.json` and validated by `scripts/validate-agent-registry.mjs` per PR #109), update script lookups (`render-wrangler.mjs`, `workspace-command.mjs`, `with-env.sh`, `setup-kv.mjs`, `workspace-typecheck.mjs`), update CI glob filters, and implement recursive test discovery.
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
- **Job State Anchoring Invariant:** The runtime data root (`JOBS_DIR`) must explicitly remain anchored to the existing `linear-agent-bridge/linear-jobs/` location (or resolve to `BRIDGE_DATA_DIR` / explicit repository root configuration) rather than deriving `JOBS_DIR` from the newly extracted `bridge/server/` module location. This guarantees pre-existing job claims, checkpoints, and review deduplication ledgers remain intact and readable without re-executing completed work.
- **Verification:** Exact HTTP contract testing on `/jobs`, `/complete`, `/health`, `/github-events`, and verification that historical job ledger records remain visible and unmodified.
- **Rollback:** Revert to monolithic `agent-bridge.mjs`.

### Phase P5: Cutover, Docs & Shim Retirement (Final PRs)
- **Objective:** Following separate human authorization, verify live bridge endpoints across Ubuntu and macOS, update runbooks, and retire compatibility shims.
- **Verification:** End-to-end OAuth and webhook delivery verification across all 7 Worker domains (`antigravity`, `chatgpt`, `chatgpt-cli`, `gemini`, `gemma`, `trae`, `mock`).
- **Rollback:** Restore compatibility shims if any unmigrated consumer remains.

---

## 11. Invariant Checklist & Sign-Off Gate

- [x] Baseline SHA recorded: `b5d4988b62b8a42424171f2b348a53e3a74b713c`
- [x] Zero live runtime data, task files, or secret keys included
- [x] Pre-move test count verified (150 reliability tests, 90 bridge tests)
- [x] Cloudflare Worker identities and custom domains mapped 1:1 (including GitHub routes and shared deployment names)
- [x] Non-destructive rollback plans and job directory anchoring defined for all stages
- [x] External skills library boundary respected
