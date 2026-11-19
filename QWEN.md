# Qwen Code — Agent Bridge project entrypoint

Read [AGENTS.md](AGENTS.md) for the repository's operational, security and routing rules before any code changes.

Use the project skill `.agents/skills/agent-context/SKILL.md` (`/agent-context` in Qwen Code) whenever a task involves coding, code review, a dependency, configuration, dispatch or deployment context. From the repository root, run `python3 scripts/agent_context_cli.py --path <repo-relative-path>` (or the equivalent `--topic` or `--files-changed`) to retrieve full source-linked README dependencies before editing. Inspect provenance and fail on missing required sources. The shared skill defines the complete workflow; do not maintain a Qwen-specific resolver or duplicate the rules here.

If the requested path has no resolver owner, report that it is unmapped, retrieve default bootstrap context with `python3 scripts/agent_context_cli.py`, and manually read the nearest relevant owning README; do not claim complete path-owned context. Follow the shared skill's partial-output policy and investigate other resolver errors.

Use `python3 scripts/agent_context_cli.py validate` after source or README context changes. This entrypoint does not grant additional filesystem access, coding permissions, agent dispatch or deployment authority.
