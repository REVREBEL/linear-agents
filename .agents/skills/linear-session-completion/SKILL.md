---
name: linear-session-completion
description: Select the Bridge-provided submission mechanism for this invocation; never infer completion from process exit.
---

# Linear Session Completion

For a managed coding job use [submit-work](../submit-work/SKILL.md). The Bridge owns GitHub publication, Linear review handoff and session completion.

For an explicitly legacy, non-managed invocation only, use the [legacy completion contract](../legacy-linear-session-completion/SKILL.md). Never fall back to it because the managed command is missing or unsuccessful.
