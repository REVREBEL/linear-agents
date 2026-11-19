---
context:
  id: repo.integrations.litellm
  version: 1
  title: LiteLLM proxy agent runtime adapter
  topics: [integrations, litellm, proxy, tools]
  requires: [repo.integrations, host.agent-tools, host.global-tools]
  applies_to: ["integrations/litellm/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# LiteLLM development runtime adapter

`agent-runtime.mjs` implements an **OpenAI-compatible Chat Completions** interface to a locally hosted LiteLLM proxy. The default API base is `http://127.0.0.1:4000/v1`; configuration validation permits **loopback-only** HTTP with the prescribed API prefix and requires an explicit model alias and virtual API key.

## Runtime and security boundaries

The caller provides an OpenAI SDK client factory, API key, model, task input, instructions and optional tool definitions. Tool selection is bounded by an explicit provided tool registry; requested names must exist, argument JSON must be valid, execution steps and response size are bounded, and status reporting goes through a supplied callback.

This adapter runs in the unprivileged development process. Its presence does **not** prove the LiteLLM proxy process is healthy or enable Bridge dispatch. Provider secrets and proxy credentials must stay in protected host runtime configuration, not Git documentation. Shared runtime dependencies relate to `host.agent-tools` and `host.global-tools`.

## Verification

`node --test integrations/litellm/agent-runtime.test.mjs`

Confirm the installed proxy endpoint, model configuration, and per-user authorization separately before any actual provider task; this README does not grant tool execution permissions.

## Update policy

Review adapter changes with its adjacent test file, provider configuration, error handling, tool allowlist and security assumptions. Context ID: `repo.integrations.litellm`.
