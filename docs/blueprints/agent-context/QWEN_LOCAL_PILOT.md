# ABR-85 (E1) — Qwen Local Registry v2-aware context pilot

**Status:** Research candidate and portable Agent Context pilot staged for review; **runtime promotion blocked** pending ABR-58. This is a documentation/context change, not a launchable Linear agent.

## Independent contract boundaries

- Research source: `agents/profiles/candidates/qwen-local.yaml`, mirrored exactly in the **current** `agents/agent-registry.yaml` (16 candidate entries). The attached `AgentRegistryEntry` JSON Schema remains unchanged and has no per-entry `profileVersion`.
- Executable source: `agents/registry.json` (Registry v2). No `qwen-local` executable entry is created by E1, and no research profile is read by dispatch/admission.
- Proposed identity: `qwen-local` is **not** the ChatGPT CLI identity. Its research Worker/tunnel hosts intentionally use `.invalid` placeholders to prevent mistaken claims of deployment or promotion.
- Reviewed promotion path: `scripts/review-research-promotion.py` requires independently approved mapping and evidence from the **actual** Worker source, model, runtime and security controls; it cannot activate an agent. ABR-58 owns the Worker, KV, OAuth identity, dispatch and checkpoint integration.

## Host pilot evidence — November 19, 2026

| Gate | Observation | Result |
| --- | --- | --- |
| Local Ollama model | `ollama list` includes `qwen3.5:9b-opencode` (Q4_K_M, 9B); `ollama show` reports tool support and `num_ctx: 16384` | Model artifact present |
| Local embeddings | `nomic-embed-text:latest` appears in `ollama list` | Artifact present; no new embedding or memU operation in E1 |
| OpenCode CLI | `opencode --version` = `1.19.5`; `opencode run --help` accepts positional prompt, `--model`, `--format json`, `--session` | CLI syntax confirmed |
| Scoped model discovery | Under a disposable `HOME` and `OPENCODE_CONFIG` pointing to `qwen-local.opencode.v1.example.json`, `opencode models ollama` returned exactly `ollama/qwen3.5:9b-opencode` | Discovery passed |
| Isolated headless inference | Disposable, credential-free `opencode run --pure --agent plan --model ollama/qwen3.5:9b-opencode --format json` did not return events before the 95-second timeout | **Blocked**; no successful response/tool/session proof |
| Dedicated Qwen Worker | No `agents/coding/qwen-local/worker` or `qwen-local` Registry v2 entry exists | **Blocked**; no Worker/OAuth/KV evidence |
| Shared ChatGPT CLI | Remains independent and pinned to its authenticated model; E1 does not change its profile or launcher | Boundary preserved |

The example JSON intentionally uses the OpenCode 1.x `provider` / `npm` / `options` shape observed with CLI 1.19.5, not unverified OpenCode 2.x configuration. Its sole endpoint is `http://127.0.0.1:11434/v1`; it includes only the Qwen model and limits the usable context to Ollama's configured 16,384 tokens, rather than advertising the architecture's 262K maximum. It is a **versioned source example awaiting PR review**, not a host installation or active agent configuration.

## Agent Context pilot

`python3 scripts/test_qwen_local_context_pilot.py` validates the research/catalog parity, isolated-only OpenCode config, non-registration in Registry v2, and a full `profiles` context handoff. The handoff includes `agents/`, `bridge/`, and all three reviewed optional host README sources; it verifies against the pinned Git commit even after the disposable host paths are deleted. The existing D5 `--check-source` verifier enforces complete seed/dependency closure.

This pilot uses temporary host README fixtures and does not read private `/opt` runtime profiles, create credentials, run a Worker or modify the Bridge service. The E2 live new-session/context retrieval acceptance remains separate.

## Promotion prerequisites (ABR-58)

1. Prove local-only headless inference, real OpenCode tool invocation and response extraction in an isolated workspace. Verify model/context budget, exact executable flags and restart/session continuity, without remote fallback.
2. Review and land the independent `qwen-local` Worker package/config and callback protocol, KV namespace mapping, Linear OAuth identity, admission controls and memory/checkpoint isolation. Capture source hashes and review evidence.
3. Obtain independently approved research-to-Registry v2 mapping; run the existing gated promotion compiler and Registry v2/Worker integration tests before proposing any executable entry.
4. Validate an authenticated Linear canary separately after credentials and deployment readiness. Nothing in E1 grants launch authority or advances ABR-58's deployment stage.

The `.invalid` research hostnames, permissive research schema, published model identifiers and SHA hashes are not identity authorization or live availability checks.
