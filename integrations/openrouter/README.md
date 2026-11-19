---
context:
  id: repo.integrations.openrouter
  version: 1
  title: OpenRouter Agent SDK runtime adapter
  topics: [integrations, openrouter, models, providers]
  requires: [repo.integrations, repo.agents]
  applies_to: ["integrations/openrouter/**"]
  update_on: [behavior, contracts, configuration, dependencies, security, deployment]
---

# OpenRouter agent runtime adapter

`agent-runtime.mjs` exports `runOpenRouterAgent`, a provider-neutral call to the **OpenRouter Agent SDK** with an explicit SDK implementation, API key, model identifier, input, instructions, optional tools and an evaluation-status callback.

The adapter checks an OpenRouter `provider/model` identifier, nonempty credentials, bounded task input and execution-step limits. It returns the provider model identifier and final response text. It does **not** choose a model, bind a Linear identity, validate project authorization, or deploy a Worker.

## Boundaries and dependencies

`repo.integrations` owns general provider integration guidance. `repo.agents` owns declarative model/agent identity contracts, which are independent of a provider SDK. Bridge admission and runtime dispatch remain in `bridge/` and `jobs/`; API credentials remain in host-protected state.

Do not mistake a candidate research profile, SDK availability or a callable model for an authorized executable Bridge agent.

## Verification

Review `agent-runtime.mjs` and run the relevant caller/provider regression tests before wiring a runtime. This folder currently contains the adapter source; no dedicated colocated `agent-runtime.test.mjs` is listed here.

## Update policy

Update provider validation, model routing, execution limits and status callbacks together with the caller contract and any new tests. Context ID: `repo.integrations.openrouter`.
