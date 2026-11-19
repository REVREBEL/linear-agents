# Agent Context D1 — one resolver across coding harnesses

**Milestone:** ABR-77 / D1. The active source of truth is `.agents/skills/agent-context/SKILL.md`. OpenCode, Codex, Qwen Code, and Mistral Vibe all discover this **single** project-local skill directory; do not create copies under `.opencode/`, `.qwen/`, `.vibe/`, `.codex/` or user-global native profile directories.

## Harness discovery and invocation

| Coding harness | Startup instruction file | Native skill entrypoint | Shared resolver |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | `$agent-context` or relevant skill discovery | `scripts/agent_context_cli.py` |
| OpenCode | `AGENTS.md` | `@agent-context` or `skill` tool | Same script |
| Qwen Code | `QWEN.md` → root `AGENTS.md` | `/agent-context` or Skills menu | Same script |
| Mistral Vibe Code | `AGENTS.md` (trusted project) | `/agent-context` or Skills menu | Same script |

The project-local `.agents/skills/` compatibility path is documented by [OpenCode](https://opencode.ai/docs/skills), [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/), and [Mistral Vibe](https://docs.mistral.ai/vibe/code/cli/skills). Codex uses the same portable Agent Skills format and location. Model-side skill discovery is not a guarantee of model invocation: the persistent `AGENTS.md` / `QWEN.md` entrypoints **explicitly instruct agents to load the skill and retrieve context before code changes**. Skill filters and individual harness permissions may still restrict a running agent's tools.

## One invocation contract

From the **Git project root** on any host with Python and the existing metadata dependencies:

- `python3 scripts/agent_context_cli.py --path bridge/server/agent-bridge-runtime.mjs` — full nearest-owner README and transitive dependencies.
- `python3 scripts/agent_context_cli.py --topic profiles --format json` — complete source-linked profile context.
- `python3 scripts/agent_context_cli.py --files-changed --format json` — owning context for changed Git paths, including `unmatchedPaths`.
- `python3 scripts/agent_context_cli.py validate` — fail-closed metadata/source validation.

The corresponding reviewed Ubuntu host command is `/opt/agent-tools/bin/agent-context --repo-root PATH --topic profiles --format json`. Other hosts may use `python` or `py -3` to invoke the **same Python source** if `python3` is not their command name. `PATH` must name the actual checkout containing `.agents/context.yaml`. Neither an installed CLI nor the skill copies the user's secrets, private native profiles, executable registry state, or research candidates.

Every complete returned README includes a canonical ID, absolute `sourcePath`, `gitSourcePath`, source Git SHA, SHA-256 content digest, dependency IDs, inclusion reasons, and full original text. The resolver enforces strict missing-source and symlink safety by default. `--allow-partial` is an **explicit opt-in** only for missing optional host READMEs; a partial bundle cannot be represented as complete. `explain` omits the bodies and cannot replace full-context retrieval.

## Integration and verification boundaries

This PR updates only repository skill/instruction entrypoints and focused tests. It **does not** add an auto-executing OpenCode plugin, Codex hook, Qwen extension, or Vibe plugin; it does not touch service runners, worker OAuth, Linear session dispatch, host configuration or agent native profile directories.

Run `python3 scripts/test_agent_context_harnesses.py` to verify the single canonical skill, syntax/entrypoint references, and a real strict resolver invocation using Git-reviewed temporary host READMEs. Existing C1–C5 and CLI/zipapp tests continue independently. A pass proves **source-level wiring and reusable command behavior**, not the model's decision to invoke a skill in every future conversation. No CLI reinstall is required to merge this D1 documentation/skill change; D2 and subsequent milestones own enforcement of authority boundaries and source-linked handoff behavior.
