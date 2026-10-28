# Linear Agent Bridge: Milestone History & Technical Evolution Timeline

The Linear Agent Bridge ecosystem coordinates automated task distribution, session lifecycle tracking, and bidirectional communication between Linear's issue tracking platform, Cloudflare Worker edge routers, and local execution agents (including Antigravity, ChatGPT Playwright automation, and Mock CLI agents). Over its development lifecycle, the system has undergone significant architectural shifts, payload optimizations, session recovery mechanics, and edge security hardening.

This document presents a documented timeline of major milestones, functional additions, protocol revisions, and bug fixes across the bridge infrastructure.

---

## 1. Routing Validation & ChatGPT URL Handling Overhaul

Early operational testing revealed routing failures where the Mac Bridge rejected incoming tasks with HTTP `422` status codes when processing Linear projects linked to existing ChatGPT conversation URLs. Analysis identified an improperly escaped regular expression in the bridge's ChatGPT URL validator that misparsed `/c/...` conversation paths.

To establish reliable project resolution, the URL validation engine was rewritten to use explicit URL-path validation. This change allowed existing ChatGPT sessions to be reused cleanly without throwing routing validation errors.

- **Key Commit:** `59b491d` (`59b491df66bc2f893c3672b80823058f5e367d19`) — *Bridge: ChatGPT URL validator fix*
- **Scope:** Local bridge routing module (`agent-bridge.mjs`). No Cloudflare Worker redeployment required.

### Routing Configuration Standards

The resolution established required configuration parameters within the bridge routing definition:

| Configuration Parameter | Required Setting | Architectural Purpose |
|---|---|---|
| `chatgpt.conversationMode` | `reuse-existing` | Prevents rejection of existing `/c/...` conversation URLs (overriding `new-per-issue`). |
| `chatgpt.autoSend` | `true` | Enables automated prompt submission via Playwright upon task receipt. |

---

## 2. LaunchAgent Runtime & Environment Hardening

During tunnel connectivity testing, Cloudflare Worker edge nodes encountered HTTP `502 Bad Gateway` errors when forwarding webhooks to local Mac Bridge instances. Inspection of the macOS LaunchAgent (`io.revrebel.agent-bridge`) revealed that the service was stuck in a crash loop (state: `spawn scheduled`, exit code `1`, over 97 failed runs).

Diagnostics identified two root causes:
1. **Restricted Shell Environment:** The LaunchAgent executed with system minimal default `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), preventing `scripts/with-env.sh` from discovering user-installed Node binaries (e.g., under NVM or Homebrew).
2. **Path & Environment Decoupling:** Launching via root-level wrappers failed to load bridge-specific environment variables (`BRIDGE_SHARED_SECRET`) required by `agent-bridge.mjs`.

```text
LaunchAgent Label: io.revrebel.agent-bridge
Plist Location:   /Users/garystringham/Library/LaunchAgents/io.revrebel.agent-bridge.plist
WorkingDirectory: /Users/garystringham/.linear-agents/
Log Target:       /Users/garystringham/.linear-agents/linear-agent-bridge/bridge-error.log
```

The runtime architecture was updated to recommend bridge-specific startup wrappers located within `linear-agent-bridge/` that explicitly export local `.env` variables before invoking `agent-bridge.mjs` directly with absolute Node paths.

---

## 3. Compact Job Payload Optimization

An inspection of saved inbox job JSON files revealed substantial data redundancy. Raw webhook payloads carried the complete issue prompt context three times across different JSON properties, producing payload sizes in excess of 13.3 KB (~3.7 KB of directly duplicated characters per job).

To reduce context overhead for downstream AI models and local storage, the bridge and worker pipeline was refactored to eliminate redundant prompt fields.

### Payload Property Changes

The table below outlines the structural pruning applied to incoming job payloads across all edge workers and local storage layers:

| Job JSON Property | Action Taken | Rationale |
|---|---|---|
| `payload.data.promptContext` | **Retained** | Maintained as the single canonical prompt containing localized routing context. |
| `payload.data.originalPromptContext` | **Removed** | Eliminated secondary copy of the raw Linear prompt. |
| `payload.original` | **Removed** | Stripped full raw webhook payload and embedded third prompt copy. |

### System-Wide Commits

This optimization was applied across all five Cloudflare Worker implementations (`linear-mock`, `linear-antigravity`, `linear-chatgpt`, `linear-gemini`, and `linear-trae`) alongside the local CLI toolset:

- **Bridge Commit:** `7ecc786` — *Bridge: compact job payload*
- **Mock Worker Commit:** `b5df989` — *Mock Worker: remove duplicates*
- **Mock CLI Commit:** `3ba8f1f` — *Mock CLI: use compact issue metadata*

---

## 4. Prompt Context Decoupling & Skill Modularization

Following the initial payload compaction, the canonical `promptContext` string still contained extraneous execution metadata, including bridge routing preambles, workspace summaries, synchronized GitHub comment notices, and embedded `curl` webhook commands.

To ensure AI coding agents received clean, focused instructions without boilerplate clutter, the bridge architecture separated execution instructions from task content:

1. **Direct-Task Prompting:** The `promptContext` field was trimmed to include strictly the Linear issue identifier (`<issue identifier="...">`), title, description, and task-specific safety constraints.
2. **Skill-Based Completion:** The embedded `curl` completion commands were removed from the prompt text and extracted into a dedicated, reusable skill file (`.agents/skills/linear-session-completion/SKILL.md`).
3. **Structured Metadata Isolation:** Repository roots, agent launch paths, session IDs, and completion URLs were moved entirely to structured JSON properties outside the prompt text.

- **Task Extraction Commit:** `49c5839` — *Direct-task extraction and formatting fix*
- **Completion Skill Commit:** `aedae06` — *Reusable completion skill*

---

## 5. Follow-Up Event Routing & Code-Review Feedback Handoff

Initial bridge implementations processed only initial `AgentSessionEvent: created` webhooks. Subsequent issue comments or follow-up prompts within an active session (such as `@antigravityagent` mentions) were ignored or misrouted because the worker did not parse follow-up text from the activity body.

To support iterative multi-turn agent feedback (such as the ChatGPT → Linear MCP → Antigravity loop), the event routing pipeline was expanded:

```text
Event: AgentSessionEvent (created)  --> Bridge starts new task via Linear promptContext
Event: AgentSessionEvent (prompted) --> Bridge extracts body from agentActivity.content.body and resumes session
Event: Ordinary Comment             --> Ignored unless explicit agent mention is detected
```

### Protocol Changes & Skill Delivery

- **Worker Event Handling:** The Antigravity Worker was updated (`7c8d9b6`) to extract follow-up instructions from `agentActivity.content.body` for `prompted` events.
- **Session Action Tracking:** The local bridge was updated (`003a690`) to preserve `sessionAction` flags, enabling jobs to distinguish between new tasks and follow-up reviews.
- **Code-Review Skill:** Introduced `.agents/skills/linear-code-review-handoff/SKILL.md` to define structured review submissions (verdicts: `CHANGES_REQUESTED`, `APPROVED`, `BLOCKED`, accompanied by PR URLs, head commit SHAs, and inline findings).

---

## 6. Authenticated Interactive CLI Toolset

Early testing utilized `npm run mock:agent` to simulate agent activities. However, because the CLI authenticated using a personal `LINEAR_API_KEY`, Linear attributed all comments and status transitions to the individual human user rather than the connected Mock Agent app.

To provide authentic simulation without identity spoofing, an interactive CLI suite was engineered to communicate directly through the Mock Worker's OAuth application credentials using `agentActivityCreate`.

### Interactive CLI Tooling Summary

The table below lists the specialized CLI scripts added to the repository:

| CLI Command | Target Script | Functionality & Identity Behavior |
|---|---|---|
| `npm run mock:submit` | `scripts/mock-agent-submit.mjs` | Prompts for multi-line comments and Linear workflow status selection; posts via Worker OAuth credentials. |
| `npm run mock:end` | `scripts/mock-agent-end.mjs` | Prompts for session outcome (`Completed` or `Failed`) and dispatches session completion signals to Linear. |

### Key Bug Fixes in CLI Utilities

During rollout of `mock:submit`, regex parsing errors and strict metadata requirements caused CLI execution failures:
- **Commit `281b3ab`:** Updated script to fall back to regex extraction of issue keys (e.g., `REV-154`) from `promptContext` when structured `job.issueMetadata.id` was absent in older inbox files.
- **Commit `4f9ebce`:** Corrected an improperly escaped regex pattern (`/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/`) that had caused Node ESM parser syntax crashes.

---

## 7. Status-Driven Local Inbox File Lifecycle

In earlier bridge iterations, inbox JSON files saved to local `.linear-agent/projects/.../inbox/` directories were scheduled for deletion immediately upon the agent session posting a completion webhook. This created operational friction during code-review loops, as files were removed before reviewers could request revisions or verify completed work.

The inbox file lifecycle was refactored to align with Linear issue state transitions rather than transient agent session events.

| Lifecycle Stage | Agent Action | Local Inbox JSON Status |
|---|---|---|
| Session Active / Working | Agent processing issue | **Retained** |
| In Review | Agent posts work notes and requests review | **Retained** |
| Changes Requested | Reviewer posts follow-up feedback | **Retained** |
| Issue Marked `Completed` / `Done` | Linear issue reaches terminal status | **Deleted** (via issue-based cleanup endpoint) |
| Session Failure | Agent encounters fatal error | **Retained** (for debugging) |

- **Bridge Cleanup Commit:** `4553eea` — *Bridge completion and inbox cleanup*
- **Session Lookup Commit:** `eb6f3b1` — *Session lookup enhancement*

---

## 8. ChatGPT Worker Metadata Enrichment Fix

During review handoffs, calls to `linear-chatgpt-agent` failed with HTTP `422` error responses (`Missing structured Linear project ID; no implicit fallback`). While standalone project routing had been fixed in the local bridge, the ChatGPT Worker was omitting `routing.projectId` during metadata enrichment.

The ChatGPT Cloudflare Worker was patched to perform robust metadata resolution prior to forwarding jobs to the local Mac Bridge:

- **Payload Inspection:** Checked for issue IDs across both standard and nested agent-session payload schemas.
- **Linear API Lookup:** Queried the Linear GraphQL API directly to resolve the issue's assigned project ID.
- **Standalone Support:** Enabled routing for standalone Linear projects lacking parent initiative associations.
- **Diagnostic Halting:** Configured the worker to halt and return descriptive errors if an issue lacks an assigned Linear project, preventing unroutable requests from reaching the Mac Tunnel.
- **Fix Commit:** `42a1d14` — *Fix ChatGPT project routing diagnostics*

---

## 9. Playwright Browser Automation & Chrome Decoupling

Automating ChatGPT web handoffs presented browser lifecycle challenges. Initially, Playwright launched visible Chrome instances, pasted the prompt, and immediately closed the browser window before ChatGPT could generate a response or allow user inspection.

A sequence of iterative fixes transformed the automation from a fragile script into a persistent, detached browser architecture.

### Evolutionary Fix Sequence

1. **Keep-Open Flag (`a64abac`):** Configured Playwright runner (`scripts/chatgpt-playwright/handoff-test.mjs`) to accept `--keep-open`, preventing script exit from triggering browser destruction.
2. **Composer Visibility Wait (`d590bdf`):** Replaced instantaneous DOM checks with a 45-second polling loop to allow ChatGPT's rich-text composer to render completely.
3. **Error Handler Decoupling (`00eb644`):** Fixed a bug where `finally` execution blocks closed Chrome unconditionally upon encountering navigation or composer errors.
4. **Text Verification Normalization (`fed730a`):** Updated text verification logic to normalize whitespace and line breaks, eliminating false mismatch rejections caused by rich-text editor rendering differences.
5. **Persistent Chrome Process Architecture (`4e7056e`, `650f388`):** Decoupled Playwright from Chrome process management. Launched Chrome as an independent macOS process exposing a local debugging port, allowing Playwright to connect, inject prompts, and disconnect cleanly without terminating the browser.
6. **Native Headless Chromium Mode (`0baca4b`, `5bb0bfc`):** Introduced a native headless Chromium execution path (`--headless`) operating on an isolated debugging port for automated CLI testing (`handoff-test.mjs`).

---

## 10. Antigravity Quota Exhaustion & Automated Session Recovery

When executing long-running coding tasks, the Antigravity (`agy`, executable at `~/.local/bin/agy`) CLI occasionally encountered API rate limits or quota exhaustion (`RESOURCE_EXHAUSTED` / `Individual quota reached`).

Rather than failing tasks permanently, a resilient retry mechanism was implemented within the Python runner (`run_agent.py`) and job ledger:

```text
1. Python runner (run_agent.py) monitors CLI output streams.
2. Quota exhaustion pattern detected --> Emits internal on_exhaustion event.
3. Bridge records session ID and schedules a 2-hour retry timer (7,200,000 ms).
4. Timer fires --> Bridge executes: agy -p "Resume task..." --conversation <id>
```

### Key Technical Safeguards

- **Explicit Conversation Targeting:** Resumption commands explicitly pass `--conversation <id>` rather than generic `-c` flags, ensuring multi-agent environments do not resume an incorrect task session.
- **State Persistence Across Restarts:** Pending retry schedules are written to the local job ledger, allowing recovery timers to survive bridge restarts.
- **Cap on Automated Retries:** Automated exhaustion retries are strictly capped at 3 attempts per task.
- **Commits:** `e0108c9` (Exhaustion detection), `a9999fc` (Bridge scheduling), `d0970cb` (Job lookup), `3aac5a1` (Session identity fix).

---

## 11. Cloudflare Edge Webhook Traffic Protection

Production Cloudflare Workers hosting bridge endpoints (`linear-antigravity.revrebel.io`, `linear-trae.revrebel.io`, `linear-chatgpt.revrebel.io`, and `linear-mock.revrebel.io`) experienced influxes of unauthorized public web traffic. To prevent invalid requests from reaching Workers or consuming execution invocations, edge security controls were designed at the Cloudflare WAF level.

### WAF Custom Security Rule Design

The security model implements a Cloudflare Web Application Firewall (WAF) rule tied to a managed IP list (`linear_webhooks`) containing Linear's published webhook source addresses.

```text
IP List Name: linear_webhooks
Published Linear Webhook IPs:
  - 35.231.147.226
  - 35.243.134.228
  - 35.196.141.51
  - 34.140.253.14
  - 34.38.87.206
  - 34.62.119.29
  - 34.134.222.122
  - 35.222.25.142
  - 34.60.255.158
```

### Expression Logic & Traffic Behavior

```text
ends_with(http.host, ".revrebel.io")
and http.host contains "linear"
and http.request.uri.path eq "/webhook"
and (
  http.request.method ne "POST"
  or not ip.src in $linear_webhooks
)

Action: Block
```

The table below summarizes how the Cloudflare WAF rule handles different traffic categories across all `linear-*.revrebel.io` hostnames:

| Endpoint Path | Request Method & Origin | WAF Action | Rationale |
|---|---|---|---|
| `/webhook` | `POST` from `$linear_webhooks` IP | **Allowed** | Valid webhook payload delivered by official Linear infrastructure. |
| `/webhook` | Non-`POST` or non-Linear IP | **Blocked** | Rejects unauthorized public traffic before Worker invocation. |
| `/install`, `/callback` | Browser GET/POST | **Allowed** | Preserves public accessibility for OAuth authorization flows. |
| `/health` | Any public client | **Allowed** | Enables external uptime monitoring and Cloudflare Tunnel health checks. |

This edge protection supplements existing worker-level `Linear-Signature` HMAC and timestamp validation, providing multi-layered defense for the entire bridge network.
