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

## Coding execution under /home/rebel

Gemma now has a **development coding** profile in `dev-runner.mjs`, separate from the original read-only inventory evaluator. Tools support source read/write/move/delete, approved `npm run` tests, git status/diff/commit on a feature branch. Remote push/merge/deploy are **not** agent tools yet.

The authenticated bridge must **not** execute model tools directly. The bridge invokes `isolated-launch.mjs`, which uses `sudo -n -H -u rebel -- <GEMMA_NODE_BIN> <worker-process.mjs>` with a scrubbed environment and JSON task on stdin. A narrowly scoped, root-owned sudoers rule must authorize only the resolved Node executable + Gemma worker process; do not permit a wildcard Node command or arbitrary scripts. The service account must not otherwise have unrestricted sudo access. The target Node executable and script paths must be verified on Ubuntu.

The Gemma OS account reads its own OpenRouter key from `/home/rebel/.config/linearbridge/openrouter.key` (owned by `rebel`, mode `0600`) outside the Git checkout. The `bridge` service must not inherit or receive the key. Do not place the key in a shell argument or Linear issue.

Keep `GEMMA_ENABLED=false` until:
1. Dedicated Gemma Linear OAuth app/Worker in PR #69 is deployed and installed, and the `gemma-agent.revrebel.io` Tunnel routes to the current authenticated bridge.
2. The target checkout is a disposable Git repo **directly under** `/home/rebel/` on a non-protected branch, with its work and local state backed up or expendable.
3. The unprivileged user can run the pinned OpenRouter SDK and project build tools. Verify the OS user cannot access production bridge environment, job directory, 1Password credentials, service controls or unrelated repos.
4. A signed test webhook reaches Gemma, and the worker confirms the Linear completion.
5. The initial assignment is ABR-28 P0 on a task branch; review its changes before further phases.

**Recovery:** after verifying the intended remote, `git fetch origin && git reset --hard origin/main && git clean -fd` restores a disposable checkout's tracked and non-ignored untracked source. Never run `git clean -fdx` on an environment containing secrets or live ignored data.
