# Gemma read-only evaluation (ABR-29)

This directory is an **isolated evaluation**, not yet a Linear agent identity or production coding runner. It uses the official `@openrouter/agent` SDK and **does not change** the ChatGPT CLI or Gemini CLI authentication and routing.

## Install on the approved host

Run this from the repository root:

```bash
npm install --prefix agents/coding/gemma
npm run test --prefix agents/coding/gemma
```

The package pins its SDK and Zod versions. The generated local lockfile should be reviewed and committed in the integration PR before production promotion. This is a non-workspace evaluation package by design, so it does not alter root `npm ci` until the adapter is accepted.

Store `OPENROUTER_API_KEY` in trusted service-user secret storage; **never commit it or paste it into Linear**. Run:

```bash
OPENROUTER_API_KEY=... npm run evaluate --prefix agents/coding/gemma -- /absolute/approved/worktree 'Inventory the current structure and propose a migration manifest'
```

The command above is an illustration of environment injection, not a recommendation to type the real key into terminal history. Use an approved secret manager or protected environment file. The test runner intentionally provides only bounded `list_directory` and `read_file` model tools. It cannot edit files, execute shell commands, create PRs, or update Linear.

## Activation criteria

1. Verify installed SDK API for the pinned version, network availability, free model `google/gemma-4-31b-it:free`, rate limits, and tool calls.
2. Approve repository allowlist and tool permissions; persist authenticated task/session lineage and completion callbacks in the existing bridge.
3. Register or approve a **separate** Linear agent identity and Worker under `agents/coding/gemma/worker/` before assigning Gemma to work. A provider model alone cannot be assigned in Linear.
4. Attach SDK streaming to generic sanitized progress, enforce timeout/cost/step ceilings, add retry/idempotency and complete the full bridge loop.
5. Only then dispatch ABR-28 **P0** to Gemma. No unattended file writes, merges, or deployments in this evaluation stage.

Source: https://openrouter.ai/docs/sdks/agent-migration
