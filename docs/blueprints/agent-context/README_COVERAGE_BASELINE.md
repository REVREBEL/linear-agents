# README coverage and broken local references

Git commit: `1a138701f8fc99af27b1280e5a8bcc9591935767`

**Advisory report** — no PR failures or forced README migration.
Uses reviewed Git files only; external URLs and heading fragments are not checked.

## Summary

- Tracked files: **844**
- Tracked READMEs: **108**
- Tracked directories: **193**
- Directories with README: **107**
- Directories lacking README: **86**
- Uncovered directories with behavioral source: **69**
- Markdown sources inspected: **127**
- Broken local references: **3**

## Directories without an own README

| Directory | Behavioral files below | Nearest ancestor README |
| --- | ---: | --- |
| `.agents/skills` | 19 | `.agents/README.md` |
| `.agents/skills/agent-context` | 1 | `.agents/README.md` |
| `.agents/skills/cloudflare` | 1 | `.agents/README.md` |
| `.agents/skills/cloudflare/references` | 0 | `.agents/README.md` |
| `.agents/skills/durable-objects` | 1 | `.agents/README.md` |
| `.agents/skills/durable-objects/references` | 0 | `.agents/README.md` |
| `.agents/skills/github-app-bot-workflow` | 1 | `.agents/README.md` |
| `.agents/skills/linear-code-review-handoff` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow` | 11 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/github-pr-submissions` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/linear-issue-closeout` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/linear-new-issues` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/linear-review-submissions` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/linear-revisions` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/linear-turn-completion` | 1 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/scripts` | 4 | `.agents/README.md` |
| `.agents/skills/linear-issues-workflow/types` | 0 | `.agents/README.md` |
| `.agents/skills/linear-session-completion` | 1 | `.agents/README.md` |
| `.agents/skills/workers-best-practices` | 1 | `.agents/README.md` |
| `.agents/skills/workers-best-practices/references` | 0 | `.agents/README.md` |
| `.agents/skills/wrangler` | 1 | `.agents/README.md` |
| `.github` | 8 | `None` |
| `.github/assets` | 0 | `None` |
| `.github/assets/fonts` | 0 | `None` |
| `.github/assets/templates` | 0 | `None` |
| `.github/scripts` | 1 | `None` |
| `.github/workflows` | 7 | `None` |
| `agents/baidu` | 1 | `agents/README.md` |
| `agents/bridge/event-intelligence` | 2 | `agents/bridge/README.md` |
| `agents/bridge/reviewer` | 4 | `agents/bridge/README.md` |
| `agents/bridge/reviewer/worker/src` | 1 | `agents/bridge/reviewer/worker/README.md` |
| `agents/coding/antigravity` | 4 | `agents/coding/README.md` |
| `agents/coding/antigravity/worker/src` | 1 | `agents/coding/antigravity/worker/README.md` |
| `agents/coding/beam` | 1 | `agents/coding/README.md` |
| `agents/coding/chatgpt-cli` | 4 | `agents/coding/README.md` |
| `agents/coding/chatgpt-cli/worker/src` | 1 | `agents/coding/chatgpt-cli/worker/README.md` |
| `agents/coding/cohere` | 1 | `agents/coding/README.md` |
| `agents/coding/gemini` | 4 | `agents/coding/README.md` |
| `agents/coding/gemini/worker/src` | 1 | `agents/coding/gemini/worker/README.md` |
| `agents/coding/gemma/worker/src` | 1 | `agents/coding/gemma/worker/README.md` |
| `agents/coding/mock` | 4 | `agents/coding/README.md` |
| `agents/coding/mock/worker` | 4 | `agents/coding/README.md` |
| `agents/coding/mock/worker/src` | 1 | `agents/coding/README.md` |
| `agents/coding/trae` | 4 | `agents/coding/README.md` |
| `agents/coding/trae/worker/src` | 1 | `agents/coding/trae/worker/README.md` |
| `agents/liquid` | 1 | `agents/README.md` |
| `agents/nvidia` | 3 | `agents/README.md` |
| `agents/parallel` | 1 | `agents/README.md` |
| `agents/profiles` | 0 | `agents/README.md` |
| `agents/recursive` | 1 | `agents/README.md` |
| `agents/stealth` | 1 | `agents/README.md` |
| `agents/thinking-machines` | 1 | `agents/README.md` |
| `conversations` | 3 | `None` |
| `docs` | 3 | `None` |
| `docs/blueprints` | 3 | `None` |
| `docs/blueprints/agent-context/bootstrap` | 1 | `docs/blueprints/agent-context/README.md` |
| `docs/blueprints/agent-context/bootstrap/.agents/skills` | 0 | `docs/blueprints/agent-context/bootstrap/.agents/README.md` |
| `docs/blueprints/agent-context/bootstrap/.agents/skills/agent-context` | 0 | `docs/blueprints/agent-context/bootstrap/.agents/README.md` |
| `docs/blueprints/agent-context/references` | 2 | `docs/blueprints/agent-context/README.md` |
| `docs/research` | 0 | `None` |
| `docs/research/antigravity` | 0 | `None` |
| `infrastructure` | 5 | `None` |
| `linear-agent-bridge` | 33 | `None` |
| `linear-agent-bridge/.trae` | 6 | `None` |
| `linear-agent-bridge/__pycache__` | 0 | `None` |
| `linear-agent-bridge/agents` | 5 | `None` |
| `linear-agent-bridge/agents/antigravity` | 1 | `None` |
| `linear-agent-bridge/agents/antigravity/scripts` | 1 | `None` |
| `linear-agent-bridge/agents/chatgpt` | 1 | `None` |
| `linear-agent-bridge/agents/chatgpt/scripts` | 1 | `None` |
| `linear-agent-bridge/agents/gemini` | 1 | `None` |
| `linear-agent-bridge/agents/gemini/scripts` | 1 | `None` |
| `linear-agent-bridge/agents/trae` | 2 | `None` |
| `linear-agent-bridge/agents/trae/scripts` | 2 | `None` |
| `linear-antigravity-worker` | 0 | `None` |
| `linear-chatgpt-worker` | 0 | `None` |
| `linear-gemini-worker` | 0 | `None` |
| `linear-mock-worker` | 1 | `None` |
| `linear-trae-worker` | 0 | `None` |
| `scripts/chatgpt-playwright` | 2 | `scripts/README.md` |
| `scripts/chatgpt-shortcuts` | 1 | `scripts/README.md` |
| `scripts/linux` | 4 | `scripts/README.md` |
| `scripts/macos` | 6 | `scripts/README.md` |
| `scripts/macos/chatgpt-shortcuts` | 2 | `scripts/README.md` |
| `shared` | 6 | `None` |
| `templates` | 8 | `None` |

## Broken local references

| Source | Target | Reason |
| --- | --- | --- |
| `.agents/skills/cloudflare/references/durable-objects/README.md:185` | `../websockets/README.md` | missing tracked target |
| `.agents/skills/cloudflare/references/tunnel/README.md:128` | `../access/` | missing tracked target |
| `.agents/skills/cloudflare/references/tunnel/README.md:129` | `../warp/` | missing tracked target |

## Scope

- Folder ownership uses the same behavioral classification as D3.
- Each tracked directory is counted even if a parent has a README.
- Broken links cover README and selected project-instruction/blueprint Markdown;
  local targets must exist in Git. No external HTTP checks or heading-anchor checks.
- A separate JSON report includes paths, source lines and examples.
- D3 same-PR enforcement remains unchanged; D4 findings are informational.

[executed on device: rebel-server.revrebel.io (f4b9a197-6987-42f5-b9b8-8e3062c922f3)]
