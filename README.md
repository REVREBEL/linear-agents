
<p align="left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme-banner_dark.jpg" />
    <img src=".github/assets/readme-banner_light.jpg" alt="REVREBEL Linear Agents" />
  </picture>
</p>



# AGENT BRIDGE

**REVREBEL's Linear-to-local-agent integration.** Four independently installed Linear app agents each use a Cloudflare Worker for OAuth, authenticated webhooks, initial Agent Session activity and completion callbacks. Workers forward jobs over Cloudflare Tunnel to a local machine. This comprehensive knowledge base synthesizes the architecture, operational runbooks, and milestone evolutions of the **REVREBEL Agent Bridge** (`I-4`), consolidating the findings across technical design documents, system audits, conversational developments, and the 44 tracked Linear issues.


> **Repository status:** The canonical hostname router implementation is [`bridge/server/agent-bridge-runtime.mjs`](bridge/server/agent-bridge-runtime.mjs). [`linear-agent-bridge/agent-bridge.mjs`](linear-agent-bridge/agent-bridge.mjs) remains an import-only compatibility loader for systemd, LaunchAgent and CLI scripts. The older `chatgpt-bridge.mjs` and `bridge_daemon.py` receivers have been retired. The Antigravity Python runner `run_agent.py` remains in `linear-agent-bridge/` and may still need to be referenced via `RUN_AGENT_PATH` on the deployed Mac.

See [AGENTS.md](AGENTS.md) for the current architecture, local file paths, safety invariants and agent development checklist. Historical review notes under `docs/` may describe older implementations.

---

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

---

### 1. Executive System Architecture & Topology

The **Linear Agent Bridge** serves as an autonomous software delivery control plane, turning Linear issues, comments, review cycles, and webhook events into a closed-loop engineering workflow. It coordinates multi-agent coding and review pipelines across a three-tier hosting topology:

```text
                                  LINEAR PLATFORM
                    (Issue Lifecycle, Agent Sessions, Team Delegation)
                                         │
                         Signed Webhook (HMAC-SHA256)
                                         ▼
                      CLOUDFLARE EDGE WORKERS & SECURITY
               linear-<agent>.revrebel.io (WAF: 15-IP Whitelist, KV, DO)
                                         │
                    Encrypted Cloudflare Tunnel (/jobs)
                                         ▼
                      UBUNTU BRIDGE DISPATCHER & RUNNER
             agent-bridge.service (systemd, port 8788, bridge user)
               ├── Core Job Durability Ledger (linear-jobs/job-state/)
               ├── Active Task Checkpoints (active-task-memory.mjs)
               ├── Headless CLI Runtimes (OpenCode, Antigravity agy, Gemini)
               └── Host Router (Local Execution vs. SSH to macOS)
                     │                                    │
       SSH (Agent Location: Macos)          Database Route (postgres.revrebel.io)
                     ▼                                    ▼
              macOS RUNTIME HOST                  POSTGRESQL 17 + memU
         (Desktop Trae, UI Testing)        (agent_memory DB, pgvector, nomic)
```

#### Core Architectural Boundaries
* **Model \\(\neq\\) Agent Runtime:** Models provide probabilistic text and structured tool-call requests; the local host (Ubuntu or macOS) acts as the runtime environment executing approved commands within bounded Git worktrees.
* **Model \\(\neq\\) Bridge Authority:** Models never hold GitHub App private keys, Linear OAuth tokens, or authority to transition issue states directly. Issue state transitions, PR publication, and session completions belong exclusively to the bridge.
* **Memory Retrieval \\(\neq\\) Memory Storage:** Deterministic active task checkpoints track immediate execution state; semantic storage (`memU` on PostgreSQL 17 + `pgvector`) manages long-term recall across sessions without modifying active runtime ledgers.
* **Control Surfaces:** **Linear** holds visible issue state; **GitHub** holds authoritative code state; **PostgreSQL 17** holds durable memory; **Agent Bridge** orchestrates the event lifecycle.

---

### 2. Ingress & Edge Security Architecture (Cloudflare Workers)

Inbound webhooks from Linear terminate at dedicated Cloudflare Worker applications deployed per agent identity:

| Agent Identity | Public Worker Custom Domain | Cloudflare Tunnel Hostname | Dispatch Path |
| :--- | :--- | :--- | :--- |
| **Antigravity** | `linear-antigravity.revrebel.io` | `antigravity-agent.revrebel.io` | `[suspicious link removed]` |
| **Trae** | `linear-trae.revrebel.io` | `trae-agent.revrebel.io` | `[suspicious link removed]` |
| **Gemini CLI** | `linear-gemini.revrebel.io` | `gemini-agent.revrebel.io` | `[suspicious link removed]` |
| **ChatGPT** | `linear-chatgpt.revrebel.io` | `chatgpt-agent.revrebel.io` | `[suspicious link removed]` |
| **Mock Agent** | `linear-mock.revrebel.io` | `mock-agent.revrebel.io` | `[suspicious link removed]` |

#### Edge Security & Ingress Hardening
1. **Cloudflare WAF Custom Rule:** Rejects all non-POST traffic or requests from unverified source IPs targeting `/webhook` across all `linear-*.revrebel.io` domains. The rule references the official 15-CIDR Linear webhook IP list (`linear_webhooks`) synchronized via scheduled worker (**ABR-30**):
   ```text
   (http.host in {"linear-antigravity.revrebel.io" "linear-trae.revrebel.io" "linear-gemini.revrebel.io" "linear-chatgpt.revrebel.io" "linear-mock.revrebel.io"})
   and http.request.uri.path eq "/webhook"
   and (http.request.method ne "POST" or not ip.src in $linear_webhooks)
   --> Action: Block
   ```
2. **Durable Ingress Coordination:** Each Worker instantiates a SQLite-backed Durable Object (`DeliveryCoordinator`) keyed by `SERVICE_NAME:organizationId`. It serializes webhook deliveries, persists incoming requests as `pending:<id>`, schedules retries using exponential backoff alarms (1 minute up to 2 hours), and prevents concurrent OAuth token refresh race conditions.
3. **Payload Pruning & Direct Task Prompting:** Webhooks originally duplicated the entire task prompt across three properties (exceeding 13.3 KB). The pipeline strips `payload.original` and `payload.data.originalPromptContext`, retaining only direct-task `payload.data.promptContext`. Embedded shell/curl completion commands were removed from prompt text and isolated into reusable skills (`.agents/skills/linear-session-completion/SKILL.md`).
4. **Resolved GraphQL Routing Regressions:**
   * **PR #80 / PR #92 / PR #97 / PR #99 / PR #103:** Closed regressions where workers forwarded incomplete routing metadata or failed on Linear's `initiativeToProjects` GraphQL query. Workers now fail closed when routing metadata is missing, categorize errors safely by stage (`issue_lookup` vs. `initiative_associations`), and gracefully fall back to verified project IDs if initiative associations are restricted (**ABR-43**, **ABR-45**, **ABR-46**, **ABR-48**).

---

### 3. Bridge Dispatcher & Local Host Orchestration

Originally hosted on macOS via LaunchAgent (`io.revrebel.agent-bridge`), the central bridge listener was migrated to Ubuntu Server under `systemd` (`agent-bridge.service`) to run persistently under the dedicated `bridge` service user (**ABR-42**, **ABR-49**).

#### Environment-Aware Host Routing (ABR-1, ABR-21)
The bridge routes assignments dynamically across physical environments using Linear's **Agent Location** label group:
* **`Agent Location: Bridge Server` (or unassigned):** Executes locally on Ubuntu under `LINUX_PROJECTS_ROOT` (`/home/rebel/linear-agents`).
* **`Agent Location: Macos`:** The Ubuntu dispatcher resolves `OSX_PROJECTS_ROOT` (`/Users/.../linear-agents`) and dispatches the job over SSH to macOS without requiring an inbound public tunnel or secondary daemon on the laptop.
* **Cross-Host Progress & Completion:** Remote macOS Trae runners stream progress back to Ubuntu via authenticated HTTPS endpoints (`/trae-activity` and `/trae-complete`) using single-use capability tokens rather than sharing global secrets.

#### Durable Job Ledger & Quota Recovery (JOB_DURABILITY.md)
The bridge tracks every task lifecycle inside a filesystem-backed state machine keyed by `sha256(agent:delivery-id)`:
```text
received ──> queued ──> launching ──> running ──> completed
   │            │           │            │
   └── unrouted └── (crash) ┴────────────┴──> interrupted
                                         │
                                   (rate limit)
                                         ▼
                                   waiting_quota
                                (2-hr backoff timer)
                                         │
                                         └──> agy -p "..." --conversation <id>
```
* **Crash Reconciliation:** On startup, the bridge converts any unconfirmed `received`, `queued`, `launching`, or `running` state to `interrupted` to prevent duplicate unverified side effects.
* **Antigravity Quota Resilience:** Upon encountering `RESOURCE_EXHAUSTED` or `Individual quota reached`, the runner captures the native AGY conversation ID, sets a 2-hour backoff timer (`AGY_RETRY_DELAY_MS=7200000`), transitions the ledger to `waiting_quota`, and automatically resumes via `--conversation <id>` (capped at 3 retries).
* **Credential Stripping:** When spawning child processes (`run_agent.py`), the bridge purges `BRIDGE_SHARED_SECRET`, `LINEAR_API_KEY`, and `LINEAR_ACCESS_TOKEN` from the child environment.

---

### 4. Agent Registry & Multi-Model Inference Architecture

The project maintains **two distinct registries**: an executable, declarative Bridge Registry v2 (`agents/registry.json` and `agents/registry.schema.json`) and a **15-entry research catalog** (`agents/agent-registry.yaml` and its `AgentRegistryEntry` schema). The catalog lists proposed agent capabilities grouped by intended role below; entries are **not proof of installation, live dispatch or model availability**. The `colab-notebook-agent` entry is a research-only candidate.

```text
                               RESEARCH MODEL CATALOG
   ┌───────────────────────────────────────┬──────────────────────────────────────┐
   ▼                                       ▼                                      ▼
AUTONOMOUS CODING AGENTS         LOCAL AIR-GAPPED CODERS          SPECIALIZED ADAPTERS
(Headless Ubuntu OpenCode)         (On-Premises Ollama)          (Direct API / Memory)
- North Mini Code (30B MoE)      - CodeGeeX4 (9B / 128K)         - Codestral FIM (Infill)
- Recursive Flint (40B MoE)      - Code Llama (Offline Syntax)   - Mistral Moderation 2603
- Gemma 4 31B (Multimodal)                                       - Liquid LFM3 1.7B (Control)
- Reflection Beam (501B MoE)                                     - Parallel Decisions Fast
- ERNIE 5.5 Flash (280B MoE)                                     - NVIDIA Nemotron Rerank VL
- Inkling 2 Small (594B MoE)                                     - Stealth Crouton (1M doc)
                                                                    - Colab Notebook (candidate)
```

#### Research Catalog Classification Matrix (proposed roles, not deployment status)
| Model ID | Provider | Kind | Transport | Autonomy | Intended Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`north-mini-code:free`** | Cohere | `cli_agent` | `headless_cli` | `Executor` | Git worktree inspection, unit test repair, CI failure fixes. |
| **`flint-v1.0:free`** | Recursive | `cli_agent` | `headless_cli` | `Executor` | Multi-turn terminal commands, deep debugging, complex refactoring. |
| **`gemma-4-31b-it:free`** | Google | `cli_agent` | `headless_cli` | `Executor` | Multimodal UI/Storybook review, architectural design, PR verification. |
| **`beam`** | Reflection AI | `cli_agent` | `headless_cli` | `Executor` | 501B frontier open-weight coding, long-horizon repository refactoring. |
| **`ernie-5-5-flash:free`** | Baidu | `cli_agent` | `headless_cli` | `Executor` | 1M context rapid repository scanning and script generation. |
| **`inkling-2-small:free`** | Thinking Machines | `cli_agent` | `headless_cli` | `Executor` | Elite multimodal reasoning and hard SWE-bench defect resolution. |
| **`codegeex4:9b`** | THUDM / Ollama | `cli_agent` | `headless_cli` | `Supervised` | Air-gapped repo Q&A and localized script edits (128K context). |
| **`codellama`** | Meta / Ollama | `cli_agent` | `headless_cli` | `Supervised` | Offline syntax and unit test authoring with zero outbound data transfer. |
| **`codestral-latest`** | Mistral | `llm` | `direct_api` | `Recommender` | Fill-in-the-middle surgical method insertion and automated lint patches. |
| **`mistral-moderation`** | Mistral | `llm` | `direct_api` | `Read-only` | Webhook inspection, issue policy classification, and prompt injection defense. |
| **`liquid-lfm3:free`** | LiquidAI | `llm` | `direct_api` | `Recommender` | Webhook event triage, metadata extraction, and checkpoint summarization. |
| **`decisions-fast:free`** | Parallel | `llm` | `direct_api` | `Read-only` | Typed web-grounded decision scoring (`noul`, `choice`, `score`) with citations. |
| **`nemotron-rerank-vl`** | NVIDIA | `llm` | `direct_api` | `Read-only` | Multimodal cross-encoder reranking for PostgreSQL/pgvector memory queries. |
| **`crouton-alpha`** | Stealth | `llm` | `direct_api` | `Recommender` | 1M-token public document and specification synthesis. |
| **`colab-notebook-agent`** | Google / Colab | `cli_agent` | `headless_cli` | `Executor` | Research-only notebook and GPU evaluation candidate; runtime, CLI command and Worker require verification. |

---

### 5. Memory, Context & Session Recovery Architecture

The bridge implements a **Three-Tier Memory Architecture** to overcome LLM context-compaction amnesia (discovered during OpenCode / Qwen evaluations on `rebel-server`, where models lost track of active tasks after compaction):

#### Tier 1: Active Task Memory (Short-Term Operational Truth)
* **Storage:** Filesystem ledger (`job-state/`) mirrored to local database checkpoints via `active-task-memory.mjs` (**ABR-8**, **ABR-9**).
* **Contract:** Keyed strictly by Linear `agentSessionId` and workspace. Persists current task objective, active Git branch, base commit SHA, modified files, test exit codes, and recent milestones (up to 20 steps with recursive token redaction).
* **Compaction Recovery:** Checkpoints are injected into prompts upon session resume or model compaction, ensuring agents do not discard work already written to disk.

#### Tier 2: Factory Brain (Curated Workspace Memory)
* **Storage:** Private PostgreSQL table / local repository file (`.linear-agent/factory-brain.md` excluded via `.git/info/exclude`).
* **Contract:** Bounded 40,000-character Markdown document defining architectural invariants, coding rules, and library conventions. Writes are approval-gated; agents cannot save unverified claims or transient debug logs into the brain.

#### Tier 3: Long-Term Semantic Memory (`memU` + PostgreSQL 17)
* **Storage:** Dedicated `agent_memory` database on `rebel-server.revrebel.io` running PostgreSQL 17.11 + `pgvector` (**ABR-5**).
* **Contract:** Embeds episodic task learnings using local Ollama (`nomic-embed-text`). Promotion into semantic memory occurs **only after** code passes tests, PR review is approved, and the Submission Coordinator verifies the matching commit SHA.

#### Upstream Session Intelligence Evaluation (ABR-11, ABR-12, ABR-13)
* **Brain Hub:** Read-only session transcript parsing is being adapted into an isolated service to inspect historical Antigravity transcripts; raw, unredacted transcripts are blocked from storage to prevent secret leakage.
* **Antigravity Sync:** Synchronizing native internal state files directly across OS boundaries was **rejected** due to path divergence (Mac `/Users/...` vs. Ubuntu `/home/...`) and race conditions violating Linear session isolation.

---

### 6. Automated Software Engineering & Review Loop

The central operational objective of the bridge is closing the autonomous development lifecycle without manual intervention:

\\[\text{Issue Assigned} \longrightarrow \text{Coding Agent} \longrightarrow \text{Git PR} \longrightarrow \text{CI Check} \longrightarrow \text{ChatGPT Review} \longrightarrow \text{Revision} \longrightarrow \text{Same PR} \longrightarrow \text{Merge}\\]

#### Past Delivered Milestones
* **Identity Separation:** The bridge strictly decouples the **ChatGPT CLI coding agent** (OpenCode runner) from the **ChatGPT User reviewer** (assigned via review inbox/issue notifications), eliminating loop feedback collisions (**ABR-7**, **ABR-44**).
* **PR Review Loop Checkpointing (ABR-6, PR #30):** Actionable GitHub PR comments and revisions trigger deterministic re-reviews, preserving per-PR review checkpoints across bridge restarts.
* **Self-Origin Loop Suppression (ABR-7):** Configured filters (`GITHUB_CHATGPT_SELF_IDS`) suppress review triggers caused by ChatGPT's own comments or commits.

#### Planned Forward Control Plane Modules
* **Submission Coordinator (ABR-17):** Provides a single bridge-owned command (`submit-work <issue-id> <summary>`) for coding agents. The coordinator verifies the local branch, mints short-lived GitHub App tokens, creates or updates the existing PR (same ID), posts verified test evidence, transitions the Linear issue to `In Review`, and closes the agent session via authenticated Worker `/complete`.
* **EventIntelligence Agent (ABR-18):** Semantic triage service for no-`promptContext` webhooks (e.g. Jules optimization comments, Renovate updates, CI check completions). Evaluated using `google/gemma-4-26b-a4b-it:free` in shadow mode to classify whether an event represents an actionable code review or routine noise.

---

### 7. Comprehensive Linear Issue & Project Delivery Ledger

A review across all **44 tracked Linear issues** in the Agent Bridge workspace establishes the current operational delivery status:

```text
   COMPLETED (30 Issues)       IN REVIEW / IN PROGRESS (3 Issues)        BACKLOG ROADMAP (11 Issues)
   ├── Edge WAF & Sync (ABR-30)  ├── Memory Coord (ABR-3 - In Review)      ├── Env Dispatch (ABR-1)
   ├── Postgres/pgvector (ABR-5) ├── Checkpoint Schema (ABR-9 - In Review) ├── Session Intelligence (ABR-12-16)
   ├── Router & Layout (ABR-28)  └── OpenRouter/Gemma (ABR-29 - In Prog)   ├── Submission Coord (ABR-17)
   ├── SSH Host Dispatch (ABR-21)                                          ├── EventIntelligence (ABR-18)
   └── Route Hardening (ABR-42-50)                                         └── Monorepo Refactor (ABR-26-27, 34)
```

| Issue ID | Workstream / Project | Status | Title & Operational Scope |
| :--- | :--- | :--- | :--- |
| **`ABR-1`** | Core | Backlog | Verified environment-aware agent dispatch registry (Linear UUID \\(\rightarrow\\) host/workspace mapping). |
| **`ABR-2`** | Core | **Done** | Fixed Storybook typecheck regressions (unused React import & duplicate keys). |
| **`ABR-3`** | PostgreSQL & memU | **In Review** | Agent memory coordinator: session checkpoints + memU durable recall. |
| **`ABR-4`** | macOS Runtime | **Done** | Integrated optional Antigravity Desktop mode with progress and blocked-tool errors. |
| **`ABR-5`** | PostgreSQL & memU | **Done** | Provisioned PostgreSQL 17 + pgvector on `rebel-server.revrebel.io` (`agent_memory` database). |
| **`ABR-6`** | Core | **Done** | Persisted GitHub PR review loop checkpoints across restarts. |
| **`ABR-7`** | Core | **Done** | Added self-origin filter to suppress ChatGPT self-authored GitHub review loops. |
| **`ABR-8`** | PostgreSQL & memU | **Done** | Incremental task checkpoints and guarded memU recall/promotion adapters (PR #31). |
| **`ABR-9`** | PostgreSQL & memU | **In Review** | Checkpoint schema extension with versioning, expiration, and recursive token redaction (PR #36). |
| **`ABR-10`** | PostgreSQL & memU | **Done** | Architecture specification for durable short- and long-term agent memory. |
| **`ABR-11`** | Session Recovery | **Done** | Documented Brain Hub and Antigravity Sync source architecture at pinned commits (PR #46). |
| **`ABR-12`** | Session Recovery | Backlog | Analyzed Antigravity session portability, workspace absolute paths, and secret leakage. |
| **`ABR-13`** | Session Recovery | Backlog | Selected upstream components and designed read-only session/archive adapter. |
| **`ABR-14`** | Session Recovery | Backlog | Staged implementation plan, host ownership, acceptance tests, and rollback boundaries. |
| **`ABR-15`** | Session Recovery | Backlog | Read-only native session inventory, transcript parser, and checkpoint linkage implementation. |
| **`ABR-16`** | Session Recovery | Backlog | Sanitized archive and gated canary with cross-machine recovery tests. |
| **`ABR-17`** | Core | Backlog | Bridge-owned Submission Coordinator (`submit-work <issue-id> <summary>`). |
| **`ABR-18`** | Core | Backlog | EventIntelligence agent: semantic GitHub/Linear webhook triage and review dispatch. |
| **`ABR-19`** | Core | **Done** | Deferred unsupported Linux ChatGPT handoffs, returning 503 instead of failing claims. |
| **`ABR-20`** | Core | **Done** | Corrected Clerk Client Hub authentication routing to top-level `/sign-in` mount. |
| **`ABR-21`** | Core | **Done** | Routed Linear jobs to Ubuntu or macOS via SSH based on `Agent Location` label. |
| **`ABR-24`** | Core | **Done** | Marked shared Clerk provider and Webflow surfaces as `"use client"` components. |
| **`ABR-25`** | Core | **Done** | Disabled SSR for Clerk Webflow authentication components. |
| **`ABR-26`** | Core | Backlog | Standardized A–Z onboarding checklist for new LinearBridge agents. |
| **`ABR-27`** | Core | Backlog | Monorepo refactor plan with external `skills-library` consumption boundary. |
| **`ABR-28`** | Core | **Done** | Implemented agent-centric LinearBridge v2 layout with colocated Workers. |
| **`ABR-29`** | Core | **In Progress** | Shared `@openrouter/agent` runtime and isolated Gemma coding profile. |
| **`ABR-30`** | Cloudflare Edge | **Done** | Scheduled read-only Cloudflare IP feed synchronization for WAF allowlists. |
| **`ABR-32`** | Ubuntu Dev | **Done** | Scoped Gemma provider credentials via 1Password minimal environment loader. |
| **`ABR-33`** | Core | **Done** | Fixed unstyled Clerk auth components inside Webflow Code Component Shadow DOM. |
| **`ABR-34`** | Core | Backlog | Antigravity: validate Ubuntu Google Cloud CLI and live progress streaming telemetry. |
| **`ABR-35`** | Core | **Done** | Added root commands to bundle and import Clerk Webflow devlink components. |
| **`ABR-36`** | Ubuntu Dev | **Done** | Fixed Gemma LiteLLM credential handling assumptions using dedicated client keys. |
| **`ABR-37`** | Core | **Done** | Surfaced bridge pre-launch rejections (422/503) as error activities in Linear sessions. |
| **`ABR-39`** | Core | **Done** | Updated Worker CI assertions to match active bridge rejection messages. |
| **`ABR-42`** | Core | **Done** | Fixed Linux bridge restart sudoers mismatch for `systemctl restart agent-bridge`. |
| **`ABR-43`** | Core | **Done** | Enforced fail-closed behavior when Linear routing metadata is incomplete. |
| **`ABR-44`** | Core | **Done** | Reused ChatGPT Linear app credentials for ChatGPT CLI worker. |
| **`ABR-45`** | Core | **Done** | Rejected Antigravity dispatches lacking verified Linear routing. |
| **`ABR-46`** | Core | **Done** | Sanitized Linear GraphQL failure logs by stage without leaking query bodies. |
| **`ABR-47`** | Core | **Done** | Added `initiative:read` OAuth scope to Antigravity routing configuration. |
| **`ABR-48`** | Core | **Done** | Restored Antigravity dispatch when initiative association lookup is forbidden. |
| **`ABR-49`** | Core | **Done** | Enforced production Linux agent CLIs run under the unified `bridge` user. |
| **`ABR-50`** | Core | **Done** | Sanitized npm `allow-scripts` environment for dry-run lockfile validation. |


---



### 8. Planned Forward Roadmap & Execution Sequence

Based on current operational dependencies, forward execution follows a gated four-phase path:

#### Phase 1: In-Flight Runtime & Telemetry Validation (Immediate P0)
1. **Complete ABR-29 (@openrouter/agent Runtime & Gemma Profile):**
   * Finalize `@openrouter/agent` SDK integration, locking version dependencies in the root lockfile.
   * Register `google/gemma-4-31b-it:free` execution profile with bounded repository scope and iteration limits.
2. **Resolve ABR-34 (Ubuntu Antigravity Progress Streaming):**
   * Validate that `linear-agent-bridge/run_agent.py` extracts structured `step_update` telemetry (file reads, edits, MCP calls) at 15-second throttle intervals on Ubuntu.
   * Confirm that initial start, progress thoughts, and terminal responses publish visibly in the Linear agent session before attempting further directory reorganization.
3. **Merge Memory Checkpoint Locking (ABR-3, ABR-9):**
   * Resolve pending code review on PR #36 to merge versioned checkpoint schemas, expiration headers, and recursive token redaction into `active-task-memory.mjs`.

#### Phase 2: Lifecycle Autonomy & Handoff Coordination (Near Term P1)
1. **Build Submission Coordinator (ABR-17):**
   * Deploy local `submit-work <issue-id> <summary>` command.
   * Automate GitHub App JWT-to-installation token exchange, update existing PRs with verified commit SHAs, transition Linear issues to `In Review`, and close sessions cleanly.
2. **Deploy EventIntelligence in Shadow Mode (ABR-18):**
   * Deploy webhook context enrichment for no-`promptContext` events (evaluating incoming PR comments, Jules suggestions, and bot activity).
   * Run in shadow mode (`EVENT_INTELLIGENCE_MODE=shadow`) using `gemma-4-26b-a4b-it:free` to benchmark precision/recall against human review decisions before enforcing dispatch.

#### Phase 3: Monorepo Architecture & External Boundaries (P2)
1. **Execute Modular Monorepo Layout (ABR-28 / ABR-27):**
   * Complete domain moves into `integrations/`, `routing/`, `jobs/`, `memory/`, and `conversations/`.
   * Colocate each agent's Worker inside `agents/coding/<id>/worker/` while preserving distinct Cloudflare Worker custom domains and KV namespaces.
   * Maintain the **external boundary to `REVREBEL/skills-library`**: the bridge must consume pinned, published skills via `integrations/skills-library/` without creating a duplicate skills catalog or publication workflow.
2. **Formalize Agent Onboarding Checklist (ABR-26):**
   * Operationalize the A–Z onboarding manifest covering Worker DNS, OAuth registration, KV provisioning, Tunnel routing, and health verification.

#### Phase 4: Session Intelligence & Deep Memory Promotion (P3)
1. **Implement Read-Only Session Recovery (ABR-12 \\(\rightarrow\\) ABR-16):**
   * Deploy read-only native session parsers to discover crashed AGY and OpenCode session states without mutating provider-owned files.
   * Link parsed native transcripts to active task checkpoints for seamless recovery across container restarts and quota exhaustion.
2. **Activate PostgreSQL + memU Semantic Promotion:**
   * Wire the Submission Coordinator's completion hook to format verified task summaries and commit them into `agent_memory` on `rebel-server.revrebel.io` using Ollama embeddings and NVIDIA Nemotron cross-encoder reranking.

---

## Node.js dependencies and npm workspaces

The five Cloudflare Workers are npm workspaces managed from the repository root. Run **one** installation from the root rather than `npm install` in each Worker folder. The root `package-lock.json` is the canonical lockfile, and dependencies are installed in root `node_modules/`.

```bash
npm install                       # install/update all workspaces (root)
npm ci                            # clean reproducible installation
npm run setup -- all              # equivalent workspace setup shortcut
npm run setup -- gemini           # select Gemini workspace + shared root deps
npm test                           # local job-store tests
npm run types                      # Wrangler types for all five Workers
npm run dev -- gemini              # develop one Worker
npm run deploy -- antigravity      # deploy one Worker
npm run deploy -- all              # deploy all five, sequentially
```

To target a single Workspace directly, npm also supports `npm run dev --workspace=linear-trae-worker` (and the corresponding `deploy`/`types` scripts). `npm run dev -- all` is intentionally disallowed because a Wrangler dev server remains running. `npm install` sets up or updates the shared toolchain, while `npm ci` installs exactly the locked dependency versions. `npm run setup -- <agent>` limits the workspace selection but still installs root-level shared dependencies; it does not create a separate `node_modules` per agent. The script is called `setup` instead of `install` to avoid npm automatically running it during `npm install`. A Worker can be deployed independently, and each retains its own `wrangler.jsonc`, KV binding, and OAuth secrets.

For local development with the root `.env`, continue to use `bash scripts/with-env.sh worker <agent> dev`. For production, `bash scripts/with-env.sh worker <agent> deploy` and `... sync-secrets` remain supported. The wrapper now uses `node_modules/.bin/wrangler` from the root, so install dependencies first. **Do not use `npm run deploy` as a substitute for syncing secrets or configuring Cloudflare credentials.** The Python bridge environment remains separate in `linear-agent-bridge/.venv/`.

## Local environment and Terraform

All local credentials and Cloudflare resource IDs are configured through one root [`.env.example`](.env.example). Copy it to an ignored `.env`. Use [`scripts/with-env.sh`](scripts/with-env.sh) to load that file for Terraform, local Worker development, production Worker secret uploads and manual bridge launches. No per-Agent `.dev.vars.example` or `.tfvars` file is required. See the [Cloudflare setup guide](infrastructure/cloudflare/README.md) before importing existing security resources; do not run Terraform apply until the deployed WAF ruleset and list are reconciled.


| Agent | Worker directory | Worker hostname | Tunnel hostname |
|---|---|---|---|
| Antigravity | `linear-antigravity-worker/` | `linear-antigravity.yourdomain.com` | `antigravity-agent.yourdomain.com` |
| Trae | `linear-trae-worker/` | `linear-trae.yourdomain.com` | `trae-agent.yourdomain.com` |
| Gemini CLI | `linear-gemini-worker/` | `linear-gemini.yourdomain.com` | `gemini-agent.yourdomain.com` |
| ChatGPT | `linear-chatgpt-worker/` | `linear-chatgpt.yourdomain.com` | `chatgpt-agent.yourdomain.com` |
| Mock | `linear-mock-worker/` | `linear-mock.yourdomain.com` | `mock-agent.yourdomain.com` |

## Repository

```text
agents/                     # Coding providers and reviewer agents
  coding/
  bridge/reviewer/worker/
bridge/
  server/                   # Canonical HTTP runtime, route composer and helpers
    agent-bridge-runtime.mjs
    http-route-composition.mjs
    http-helpers.mjs
  handlers/                 # Diagnostics, GitHub, review and Trae callbacks
  config/                   # Host-to-agent resolution
  orchestration/            # Admission, execution, review and prompt parsing
jobs/
  admission/                # Identity, preflight and unrouted recovery
  dispatch/                 # Provider-specific launch adapters
  preparation/              # Task payload preparation
  lifecycle/                # Process state and ordered progress
  persistence/              # Durable job ledger
routing/
  hosts/                    # Trusted execution-host mapping
  ssh/                      # Mac transport and callback capabilities
conversations/              # Session queue and recovery
memory/                     # Task checkpointing and optional memU
integrations/               # Linear, GitHub and model runtimes
shared/                     # Cross-worker common contracts
scripts/                    # Setup, deployment and isolated tests
docs/                       # Architecture and operations
linear-agent-bridge/
  agent-bridge.mjs           # Stable systemd / LaunchAgent compatibility loader
  linear-jobs/               # Existing runtime state (not source controlled)
  agents/                   # Path-sensitive CLI runner integrations
  run_agent.py               # Antigravity Python runner
```

Each Worker retains its own `wrangler.jsonc`, `src/index.ts`, and workspace `package.json`, while npm dependencies and the lockfile are shared at the root. The shared source is duplicated between Worker folders, so a fix in one does **not** automatically reach the others.

---

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

Copy `[linear-agent-bridge/routing.example.json](linear-agent-bridge/routing.example.json)` to `routing.json` in the **live bridge folder**. Set `PROJECTS_ROOT` or edit `projectsRoot` to the actual Mac repositories parent directory. The example is built from the current Linear initiative/project IDs. Verify the GuestBridge repository mapping and any project scopes still set to `.`.

Each successfully routed job is saved beneath the Git repository at `.linear-agent/projects/<Linear-project-UUID>/inbox/` before dispatch. The bridge writes a local `/.linear-agent/` exclusion into `.git/info/exclude` when available. If the initiative, project, or directory mapping is missing, the job is saved under the central `linear-jobs/<agent>/` as `*.unrouted.json`, and the bridge returns HTTP 422 instead of launching into the wrong workspace.

**Deployment note:** The five Workers must be deployed from their respective directories, and the changed local router must be installed/restarted on the Mac. Git commits alone do not replace a live LaunchAgent process or deploy Workers. The Linear GraphQL enrichment schema and live delivery should be validated using a smoke-test Agent Session before depending on it.

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

**Completion authentication:** The trusted local Python runner reads `BRIDGE_SHARED_SECRET` to send authenticated activities to the Worker `/complete` endpoint. The AGY CLI subprocess does **not** receive this secret, `LINEAR_API_KEY`, or `LINEAR_ACCESS_TOKEN`. Never include secrets in agent prompts or issue text. Other agent handoff integrations may have separate callback requirements.

## Local service

The canonical router implementation is [`bridge/server/agent-bridge-runtime.mjs`](bridge/server/agent-bridge-runtime.mjs), loaded by the unchanged operational entrypoint [`linear-agent-bridge/agent-bridge.mjs`](linear-agent-bridge/agent-bridge.mjs). Its `PROJECT_DIR` remains pinned to the original entrypoint directory, preserving `linear-jobs/` and runner paths. It listens on `127.0.0.1:8788` and routes by Tunnel `Host` header. Antigravity launches `RUN_AGENT_PATH` with Python, Trae launches its configured CLI, Gemini supports headless mode or a Warp interactive launch, and ChatGPT can prepare or automatically launch an existing-conversation handoff through Playwright or a native [Apple Shortcut](docs/CHATGPT_SHORTCUTS_HANDOFF.md). Configure `RUN_AGENT_PATH` to point to the actual deployed `run_agent.py` location; the repository keeps that Python file at its root.

## Documentation

See **[Architecture & Operations](docs/AGENT_BRIDGE_ARCHITECTURE_AND_OPERATIONS.md)** for design decisions, installation, OAuth flow, observed failures, security caveats, operational checks, and prioritized code-review findings.

---

Example organization · [yourdomain.com](https://yourdomain.com)

## npm agent commands

The root npm scripts support `antigravity`, `chatgpt`, `gemini`, `trae`, `mock`, or `all`. **Setup always installs the shared dependency tree for all workspaces**, even when an individual agent is selected, because workspace-scoped installs conflict with the root `allowScripts` policy:

```bash
npm ci                               # install all five workspaces from lockfile
npm run setup -- mock                # install shared dependencies at repo root
npm run setup -- all                 # same root install (all workspaces)
npm run dev -- mock                  # run one agent's Wrangler development server
npm run deploy -- mock               # deploy one Worker
npm run deploy -- all                # deploy all five Workers, sequentially
npm run types                        # generate Wrangler types for all five
npm run types -- mock                # generate Wrangler types for Mock only
```

For a single agent's Wrangler types use `npm run types -- mock` or `npm run types --workspace=linear-mock-worker`. The all-agent `dev` command is intentionally unsupported because each Wrangler development server stays running; start separate terminals for each agent instead. Deploying `all` requires all five Worker configurations, KV namespace IDs, domains, and secrets to be ready. `deploy` does not create DNS/KV or synchronize secrets. To sync secrets with root `.env`, use `bash scripts/with-env.sh worker mock sync-secrets` or substitute another agent name.

## Cloudflare runtime TypeScript types

Workers use Wrangler-generated `worker-configuration.d.ts` runtime declarations rather than `@cloudflare/workers-types`. After changing a Worker's `wrangler.jsonc`, regenerate its declarations:

```bash
npm run types -- mock    # just Mock Agent
npm run types            # all five Workers
```

The newly scaffolded Mock Worker does not have a committed generated declaration yet. Run `npm run types -- mock` locally after setting the Mock Worker's KV namespace ID in its Wrangler configuration. The Worker TypeScript configurations include `worker-configuration.d.ts` automatically. For static typechecking, run `npx tsc --noEmit -p linear-mock-worker/tsconfig.json` (or substitute another worker). Generated declaration files may contain runtime-specific configuration metadata, so review generated file changes before committing them.

## Private Worker deployment values

The tracked `wrangler.jsonc` files contain generic example URLs and an invalid placeholder KV ID. Put `DOMAIN=yourdomain.com` and `<AGENT>_KV_NAMESPACE_ID` (for each enabled agent) in the git-ignored root `.env`. The `npm run types -- mock`, `npm run dev -- mock`, and `npm run deploy -- mock` commands automatically load that file and render an untracked temporary Wrangler config, including `LINEAR_REDIRECT_URI`, `BRIDGE_URL`, and the `LINEAR_DATA` KV ID. Config files are removed when each command exits. Use `bash scripts/with-env.sh worker mock sync-secrets` to set OAuth/secrets separately.

Generated `worker-configuration.d.ts` files are deliberately ignored and must be regenerated locally after pulling or updating Wrangler configuration. They may contain domain-specific runtime metadata and should not be committed. Old deployment details present in earlier Git history are not erased by these changes.

### Agent prefixes

A single `DOMAIN` and an optional `<AGENT>_PREFIX` per agent control the generated Worker settings. For example, `CHATGPT_PREFIX=chatgpt` derives the Worker name `linear-chatgpt-agent`, the OAuth redirect `https://linear-chatgpt.yourdomain.com/oauth/callback`, and the bridge URL `https://chatgpt-agent.yourdomain.com/jobs`. In `.env`, `CHATGPT_HOST="${CHATGPT_PREFIX}-agent.${DOMAIN}"` and `CHATGPT_WEBHOOK_URL="https://linear-${CHATGPT_PREFIX}.${DOMAIN}/webhook"` are optional conveniences for bridge settings and registering the webhook in Linear; the deploy renderer derives URLs itself. Prefix defaults to the agent name when unset. Changing a prefix after deployment changes the Worker name and therefore may create a new deployment; retain existing prefixes unless migrating intentionally.

## AGY exhaustion and resume

The bridge detects an AGY quota-exhaustion event emitted by `linear-agent-bridge/run_agent.py` and stores a delayed retry in the job ledger. After two hours by default (`AGY_RETRY_DELAY_MS=7200000`) it resumes the **specific** AGY conversation by ID with a short instruction. It does not use the most recent conversation in the workspace as a fallback. The retry cap is three. Actual exhaustion detection and CLI conversation-ID reporting require a live smoke test.

**Issue completion vs session completion:** The inbox task file is removed only after the bridge receives an authenticated `/issue-completed` notification for an issue confirmed Done. Session termination or quota exhaustion does not remove it.

## ABR-94 — Local MCP proof only

[The remote MCP upstream/source audit](docs/audits/mcp/README.md) and [tool parity contract](docs/audits/mcp/tool-parity.json) document the planned self-hosted Desktop Commander port (30 connected tools, 42 BRC agent tools, three relay tools). This branch adds an **offline/local, read-only relay+host fixture** using pinned `ws@8.21.0` with no production listener, OAuth, command execution, third-party file transfer, or deployment. The existing `bridge/server/agent-bridge-runtime.mjs`, `/jobs` identity, review inbox and job ledger remain authoritative. See ABR-95–100 for staged completion and deployment decisions.

### ABR-59 — Native memU multi-scope PostgreSQL canary (M10)

The explicit disposable PostgreSQL 18 canary verifies native memU promotion, signed source approvals, five exact-scope persisted recalls, four independent scope-mismatch denials, tamper/duplicate rejection and fresh-process recovery after cluster restart, using local 768-dimensional embeddings. Run it as the bridge user; see [M10 host acceptance](docs/ABR59_MEMU_ISOLATION_CANARY.md). This is application-level scoped retrieval, not production database authorization.

### ABR-59 — Linear completion evidence (M9)

The opt-in, unwired Linear completion adapter requires a host-owned credential provider, a pinned team, a completed issue and an exact attached PR URL, then independently checks that PR against GitHub and rechecks Linear state and attachments. See [M9 contract](docs/ABR59_LINEAR_COMPLETION.md).

### ABR-59 — GitHub App review-evidence client (M8)

An **unwired** host-side GitHub REST client now supplies the independent merged-PR, same-SHA review/CI and reviewer-permission evidence required by the existing promotion verifier. It takes a trusted installation-token provider, enforces fixed GitHub API routes and bounded complete pagination, and rejects incomplete or failed responses before they can become approval evidence. See [M8 contract](docs/ABR59_GITHUB_REVIEW_CLIENT.md).

### ABR-59 — Reviewed Git-object source verification (M7)

An **unwired** trusted-source verifier now checks a short learning against the **exact, regular Git blob** at its reviewed commit, under an operator-pinned repository checkout and origin. A real local-Git integration test confirms that only matching tracked source can enter the M6 HMAC approval store; mutable working-tree edits and model-invented paraphrases cannot authorize the same record. See [M7 contract](docs/ABR59_TRUSTED_GIT_SOURCE.md).

### ABR-59 — Durable signed source-approval authority (M6)

An **unwired** approval store now seals independently source-verified learning records only after checking an existing journal proof. A private 0700 directory and 0600 records use atomic publication and an operator-supplied HMAC key. Restart loading verifies the signature, exact tenant/agent/repo/issue and expiry, and produces the trusted receipt mappings/digests required by the M5 reader. This does **not** activate memory injection or make the service a general-purpose signing authority. See [M6 contract](docs/ABR59_APPROVAL_AUTHORITY.md).

### ABR-59 — Read-only database-scoped memU recall (M5)

A new **unwired** PostgreSQL reader applies scoped `user_id` and `agent_id` filters to both parent recall files and child segments *before* any content leaves the database, then checks the result against separate approved source material and digests. An isolated synthetic-scope SQL probe passed against live `agent_memory` in read-only mode. This is not database row-level security, automatic prompt injection or a production-ready trusted source loader. See [M5 contract](docs/ABR59_AUTHORIZED_READ.md).

### ABR-59 — Verified memU commit executor and disposable canary (M4)

A default-unwired commit executor now requires independently verified source evidence, GitHub same-SHA approval/CI, matching completed Linear issue, and a durable one-shot journal claim before memU `commit`. Uncertain outcomes block automatic replays. The installed memU CLI successfully committed and retrieved a synthetic learning from a disposable SQLite store with local `nomic-embed-text`, without touching the live PostgreSQL memory database. See [M4 contract](docs/ABR59_COMMIT_EXECUTOR.md).

### ABR-59 — Durable verified memory-promotion receipts (M3)

A private local journal can record authenticated GitHub-review/CI verification proof with exact tenant/agent/repository/issue and PR SHA keys. Receipts publish atomically, suppress duplicate staging, and can be enumerated after restart. They remain **awaiting executor**, not committed memU memory; the separate, approved actual memU commit path is not yet enabled. See [ABR-59 M3 journal contract](docs/ABR59_PROMOTION_JOURNAL.md).

### ABR-59 — Scoped and independently digested recall references (M2)

The optional memU retrieval module can now return a bounded provenance-bearing **lower-trust reference envelope** only when the Bridge supplies an independently approved SHA-256 digest set for the exact tenant, agent, repository and issue. Malformed, stale, cross-scope, and known injected/secret-bearing examples fail closed. The task preparation query is derived only from trusted route and issue fields; recalled text remains **withheld from the agent prompt**. See [M2 contract](docs/ABR59_SCOPED_RECALL.md).

### ABR-59 — Private memU runtime and read-only diagnostics (M1)

The optional memU recall adapter now supports direct execution of the approved absolute CLI using a privately owned, mode-0600 operator config file. A read-only diagnostic verifies the actual memU CLI and scoped PostgreSQL environment without exposing credentials. This is an **opt-in runtime boundary**, not automatic memory injection, approval-gated posting or service activation. Tests are registered in the bridge/reliability suites. See [ABR-59 runtime contract](docs/ABR59_MEMU_RUNTIME.md).

### ABR-93 — Local synthetic memory recall evaluation

The bridge and reliability regression suites include `memory/evaluation/recall-benchmark.test.mjs`. The [ABR-93 benchmark](memory/evaluation/README.md) compares 768-dimensional local `nomic-embed-text` similarity to a lexical proxy on scoped, source-pinned synthetic documents. The evaluation proposes **no new reranker** or live recall activation. memU storage, indexes, operator approvals, and agent prompts remain unchanged.

### ABR-92 — Trusted memU promotion verification (M1)

The bridge and reliability regression suites now include `memory/promotion-verification.test.mjs`. The read-only prerequisite verifies a merged GitHub PR's exact 40-hex HEAD SHA, current authorized reviewer approval and latest passing required checks from trusted CI apps through a Bridge-owned client. The legacy `scripts/memu-promote.mjs` standalone path rejects untrusted JSON claims and does **not** invoke the unsupported core memU `memorize prepare` command. No durable evolution, commit, production activation or memory-writing adapter is included. See [ABR-92 verifier](docs/ABR92_PROMOTION_GATE.md).

### Scoped Factory Brain references (ABR-91 M1)

The local task-preparation path optionally loads a private, read-only Factory Brain snapshot for the exact tenant, agent and repository when an operator pins its approved SHA256 digest. Bounded reference data never overrides Git-owned instructions, authorizes work, or edits memory. Without an approved digest, admission remains unchanged. `memory/factory-brain.test.mjs` is registered in bridge and reliability suites; see [ABR-91 Factory Brain contract](docs/ABR91_FACTORY_BRAIN.md). This is an offline implementation, **not** a production rollout, MCP integration, or PostgreSQL migration.

### Scoped checkpoint recovery

The bridge and reliability test suites include `memory/verified-recovery.test.mjs`, covering scoped local task recovery, expired records and ownership changes. See [checkpoint recovery](docs/ABR90_M1_CHECKPOINT_RECOVERY.md) for the M1 boundary and follow-up gates.

## ABR-95 — MCP OAuth resource and versioned protocol fixture

The [ABR-95 OAuth/Cloudflare acceptance](docs/audits/mcp/OAUTH_EDGE.md) adds an opt-in, local-only verified OAuth resource-server mode and 2026-07-28/2025-11-25/2025-06-18 MCP request compatibility tests to the isolated ABR-94 proof. It never changes the production Bridge listener, worker OAuth, host routing, memory authority, Cloudflare ingress or live user access. External IdP selection, client registration and deployment remain separate approved tasks.

## ABR-96 — Authenticated Ubuntu sandbox executor (source-only)

The [ABR-96 executor implementation and safety gate](docs/audits/mcp/EXECUTOR.md) add separately scoped interactive Python/shell process handles and SQLite-idempotent execution jobs, in a Linux Bubblewrap namespace with no network access and a pinned project-FD mount. Its use remains **explicitly separate** from production `agent-bridge.service`, `jobs/persistence/job-store.mjs`, existing MCP `tools/call`, and Cloudflare ingress. Rootless Bubblewrap is currently **blocked by AppArmor for the real `bridge` service user**; no unsandboxed or elevated fallback is allowed. The unit candidate is inert and must be explicitly approved after successful service-user probing and ABR-97/98 host/tool integration.

## ABR-97 — Verified macOS SSH and source-only device enrollment

[ABR-97 host authorization and Mac audit](docs/audits/mcp/MACOS_HOST.md) adds separately signed/operator-approved `macos-runtime` and `rebel-server` enrollment, trusted interactive versus Linear admission, fail-closed host selection and actual read-only discovery of the current Mac launchd identity and repository root. It does not register new devices, run an MCP command on Mac, change the existing Ubuntu/Mac Bridge services or install a launchd agent. Mac OS confinement and Ubuntu `bridge` AppArmor gates remain open.

## ABR-98 — MCP tool profiles, source adapters and guarded document export

[ABR-98 profile/handler audit](docs/audits/mcp/PROFILES.md) adds opt-in `core`/`focused`/`full` MCP discovery, verified per-tool grants independent of profile visibility, deterministic REPL status, sandboxed read-only Git, bounded TypeScript/JavaScript AST search and dry-run patch, and an offline PDF renderer with separate document-write authority. Source-level 30/42/3 parity remains tracked; unimplemented tool behavior is not advertised, and the running Bridge, Mac and Ubuntu services are unchanged.

## ABR-99 — MCP milestones and authenticated review handoff (source-only)

The [ABR-99 integration contract](docs/audits/mcp/BRIDGE_INTEGRATION.md) binds Bridge-verified MCP tool milestones to the existing job ledger and CAS checkpoint, with durable replay checks, bounded recovery and optional D5 source-linked handoff. It reuses the existing human ChatGPT review inbox, scoped by PR and full SHA, **only** behind an independently verified ABR-17 submission coordinator. ABR-17/ABR-18 production dependencies remain open; no MCP client is able to authorize a Linear job or trigger GitHub/Linear/Worker/memU writes by itself.

### ABR-59 — Host memory authority (M11)

The unwired host authority pins job identity and review policy, checks confirmed native commit markers, and loads operator-controlled signing keys and read-only GitHub/Linear evidence. Live credential verification and production activation remain outstanding. See [M11 authority contract](docs/ABR59_HOST_MEMORY_AUTHORITY.md).

The M11 Linear provider now manages its own read-only client-credentials access-token lifecycle in the operator-owned authority directory, with automatic demand-driven renewal, bounded unauthorized-response recovery and pinned identity checks. Provision the client ID and secret rather than a manual access token. See [M11 OAuth setup](docs/ABR59_HOST_MEMORY_AUTHORITY.md).


## ABR-17 M1 — Durable submission coordinator

The [submission coordinator milestone](docs/ABR17_SUBMISSION_COORDINATOR.md) provides a disabled-by-default, trusted-adapter state machine and durable effect journal. Runner ingress, credential brokerage, actual publication adapters and deployment are separate gates.

## ABR-17 M2 — Private submission transport and Git verification

[Submission contract](docs/ABR17_SUBMISSION_COORDINATOR.md) now includes a private launcher-bound IPC command, exact job/runner and app-installation mappings, a host-only read-only GitHub App broker, and confined Git readiness preflight. It is source-only; deployed provider launchers and publication remain separately gated.

## ABR-17 M3 — Provider publication and recovery

[Submission contract](docs/ABR17_SUBMISSION_COORDINATOR.md) adds scoped GitHub PR publication/reuse, mapped Linear OAuth writes, Worker completion verified by actual session activity reads, durable failed/blocked receipts and canonical review inbox recovery. Provider APIs are exercised against isolated fixture responses; runtime activation still requires M4/M5.

## ABR-17 M4 — Managed provider finish paths

The [submission coordinator contract](docs/ABR17_SUBMISSION_COORDINATOR.md) describes the opt-in authenticated Linux managed dispatch for AGY, Trae and OpenCode, one shared IPC/MCP finish operation, and the required protected host binding. Native provider isolation and descriptor propagation remain M5 operational gates.

## ABR-17 M5 — Operational acceptance

See [M5 operational evidence and rollback](docs/ABR17_SUBMISSION_COORDINATOR.md#m5--operational-evidence-operator-recovery-and-rollback). Managed activation is fail-closed until the clean release is independently approved and the actual non-root service sandbox passes. Source fixtures and observed host blockers are tracked separately.

## ABR-59 M12 — Database authorization and production-safe persistence

The ABR-59 M12 restricted PostgreSQL persistence path and its scope identity tests are included in the Bridge and reliability suites; the native disposable database and operator rollout procedures are documented in [memory/README.md](memory/README.md) and [the M12 database authority runbook](docs/ABR59_DATABASE_AUTHORITY.md). These changes do not activate the production memory service.

## ABR-59 M13 — opt-in verified memory lifecycle

The [M13 lifecycle contract](docs/ABR59_VERIFIED_MEMORY_LIFECYCLE.md) adds an operator-side pinned GitHub/Linear/native memU promotion coordinator and disabled-by-default, protected Bridge client hooks for issue-completion hints and bounded, lower-trust task reference injection. A separate root-controlled operator service and live database rollout require M14 approval; the existing Bridge service remains unchanged until explicitly activated.
