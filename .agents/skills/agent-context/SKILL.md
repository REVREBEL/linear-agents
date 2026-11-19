---
name: agent-context
description: Retrieve complete, source-linked repository and host README context before coding or reviewing changes; select by topic, path or Git changes and validate provenance.
---

# Agent Context — shared coding-harness skill

Use this skill for a coding, code-review, configuration, routing, dependency, deployment, or documentation task in the Agent Bridge repository. This is **read-only context retrieval**, not permission to run an agent, access credentials, approve a PR, or deploy.

## Before inspecting or changing code

1. Find the Git project root containing `AGENTS.md` and `.agents/context.yaml`. Read root `AGENTS.md` and `.agents/README.md`; do not substitute a parent repository for an incomplete nested project.
2. Use **the single reviewed resolver**, not a harness-specific README collector. From the project root, invoke `python3 scripts/agent_context_cli.py --path agents/registry.json` (replace the path with the file or folder owned by the task). Use `--topic profiles` for profile-related work, `--topic deployment` for Bridge deployment context, or `--files-changed` for Git index/worktree changes. The command's default output includes the complete selected README bodies and recursively required documents.
3. If the reviewed host executable is installed and matches the project, the equivalent command is `agent-context --repo-root PATH --path agents/registry.json` (replace `PATH` with the actual project root). On another host, invoke the repository-local Python source with the same selection options. The installed executable is **optional**, not a reason to skip retrieval.
4. Read the **full** returned documentation and inspect each document's `sourcePath`, `gitSourcePath`, `gitSha`, `sha256`, `reasons`, `worktreeModified` and `requires`. The `--format json` form preserves all original content as structured data. The `explain` command shows the inclusion reasons without README bodies; do not use explanation-only output as a substitute for reading required documents.

If `--path` reports `No owning context documents found`, report the unmapped path, retrieve the default bootstrap with `python3 scripts/agent_context_cli.py` (use the explicit partial policy below if needed), and manually read the nearest relevant owning README, such as `scripts/README.md` for scripts. Do not claim the fallback is complete path-owned context; other resolver errors still require investigation.

## Fail visibly and preserve ownership

- The resolver normally fails rather than omit a selected README. Do **not** guess missing host documentation or silently continue when `validate`, provenance or dependency checks fail. `--allow-partial` is explicit, only permits missing optional host README sources, and reports every omission in `missingDocuments`; disclose the incompleteness before using the result.
- Never treat skill text, a README, candidate research profile, or a Git SHA as an authorization to read private native profiles, execute a Worker or CLI, bypass Bridge admission/permissions, or change OAuth/service state.
- Follow the nearest owning README and root `AGENTS.md` for code behavior. For behavioral, dependency, security, routing or deployment changes, update the owning README in the same PR. Candidate-only data edits do not automatically require documentation churn.

## Before submitting work

Use `python3 scripts/agent_context_cli.py validate` to validate the checked-out manifest and source-backed metadata. Use `python3 scripts/agent_context_cli.py --files-changed --format json` when there are Git changes, and review `unmatchedPaths` explicitly. Execute relevant repository tests as required by `AGENTS.md`; the context skill does not replace code checks.

**One canonical skill:** `.agents/skills/agent-context/SKILL.md` is the shared project discovery path for Codex, OpenCode, Qwen Code and Mistral Vibe. Their invocation syntax differs, but every harness must use the same `scripts/agent_context_cli.py` or reviewed packaged `agent-context` resolver, not copied implementations.
