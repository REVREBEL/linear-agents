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

The Gemma worker now invokes `/usr/bin/zsh -c` as the restricted `rebel` user. Zsh sources `/home/rebel/.zshenv`, where `load_op_env` retrieves the secret values from 1Password. The loader's output is suppressed; only the selected `OPENROUTER_API_KEY` is returned over an in-process pipe to the `rebel` Node worker. `AGENT_BRIDGE_PRIVATE_KEY`, `MISTRAL_API_KEY` and `BEAM_API_KEY` are **not passed to Node or the bridge**. The temporary Zsh loader itself will hold all variables that `load_op_env` supplies, so restrict access to `.zshenv` and the 1Password identity accordingly. No static credential files are required. Do not place keys in arguments or Linear issues.

The bridge retains its existing `sudo -n -H -u rebel -- <GEMMA_NODE_BIN> <worker-process.mjs>` launch. Check `GEMMA_NODE_BIN` against the absolute executable under `rebel` and keep its sudoers allowance exact (never wildcard). The `load_op_env` call runs only *inside* the restricted worker, never in the privileged bridge.

Keep `GEMMA_ENABLED=false` until:
1. Dedicated Gemma Linear OAuth app/Worker in PR #69 is deployed and installed, and the `gemma-agent.revrebel.io` Tunnel routes to the current authenticated bridge.
2. The target checkout is a disposable Git repo **directly under** `/home/rebel/` on a non-protected branch, with its work and local state backed up or expendable.
3. The unprivileged user can run the pinned OpenRouter SDK and project build tools. Verify the OS user cannot access production bridge environment, job directory, 1Password credentials, service controls or unrelated repos.
4. A signed test webhook reaches Gemma, and the worker confirms the Linear completion.
5. The initial assignment is ABR-28 P0 on a task branch; review its changes before further phases.

**Recovery:** after verifying the intended remote, `git fetch origin && git reset --hard origin/main && git clean -fd` restores a disposable checkout's tracked and non-ignored untracked source. Never run `git clean -fdx` on an environment containing secrets or live ignored data.

## LiteLLM gateway (Ubuntu bridge, authenticated client)

The Ubuntu LiteLLM proxy is installed and operational under the `bridge` service account. Live testing on November 12, 2026 confirmed that the proxy requires client authentication via `LITELLM_MASTER_KEY`, forwards to OpenRouter, and returns the upstream Google AI Studio free-model HTTP 429 when the shared pool is limited. A 429 is not an authentication failure. **Never automatically fall back to a paid model.**

The existing proxy configuration retains a dynamic OpenRouter mapping (do not replace the wildcard with a hard-coded model):

```yaml
model_list:
  - model_name: "openrouter/*"
    litellm_params:
      model: "openrouter/*"
      api_key: "os.environ/OPENROUTER_API_KEY"
```

LiteLLM's outbound `OPENROUTER_API_KEY` and inbound API credentials are different. The privileged `LITELLM_MASTER_KEY` is for proxy administration and must **not** be passed to Gemma. Provision a separate LiteLLM virtual client key restricted to the approved free model and appropriate budget/rate permissions. Store it in 1Password so `/home/rebel/.zshenv`'s `load_op_env` makes it available as `GEMMA_LITELLM_API_KEY` to the short-lived credential loader only. Do not store the key in Git, `routing.json`, task JSON, or the bridge environment; do not forward upstream credentials to the proxy as a bearer token. The worker fails closed if the scoped client key is missing.

Use the verified local URL and dynamic alias:

```bash
GEMMA_PROVIDER=litellm
GEMMA_LITELLM_BASE_URL=http://127.0.0.1:4000/v1
GEMMA_LITELLM_MODEL=openrouter/google/gemma-4-31b-it:free
```

For a smoke test, authenticate to `http://127.0.0.1:4000/v1/chat/completions` with the **scoped client key** and request exactly `openrouter/google/gemma-4-31b-it:free`. A 429 with `limit_source: upstream_provider_shared_pool` means the proxy authentication and OpenRouter routing both worked, but the provider lacked capacity. The Node worker uses the pinned OpenAI SDK with the scoped proxy client key; direct `GEMMA_PROVIDER=openrouter` continues to use the official OpenRouter SDK and its separate `OPENROUTER_API_KEY` loader.

Virtual-key creation/configuration depends on the installed LiteLLM database/auth setup; verify this on the running service before enabling the profile. `GEMMA_ENABLED` must remain disabled until the scoped credential exists and an end-to-end isolated job + Linear completion test succeeds. Never merge, deploy, or restart production services as part of this documentation-only setup.

**Important:** The existing `/home/bridge/agent-bridge` checkout contains ignored `.env` and `.venv` state. Do not reset or clean it. Gemma's source write permissions apply only to its disposable development repository under `/home/rebel/`.

## Verify 1Password integration on Ubuntu

Run as `rebel`, without printing secret values:

```bash
cd /home/rebel/linear-agents
npm install --prefix agents/coding/gemma
npm run test --prefix agents/coding/gemma

env -i HOME=/home/rebel USER=rebel LOGNAME=rebel PATH="$PATH" /usr/bin/zsh -c '
  load_op_env >/dev/null 2>&1 || exit 1
  [[ -n "$OPENROUTER_API_KEY" ]] && print "PASS: provider secret available"
'
```

The worker requires a noninteractive 1Password session with permission to read the secret. Do not set `GEMMA_ENABLED=true` until the exact sudoers permission, isolated-user launch, approved test repository, and Linear callback have been verified. This change does not deploy the Cloudflare Worker or enable dispatch automatically.
