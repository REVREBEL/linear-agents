# Ubuntu /opt scripts: review-first import

This repository already contains the Agent Bridge at `linear-agent-bridge/`, project scripts at `scripts/`, and an **existing agent registry** at `agents/`. None of those directories should be replaced by an unchecked copy of host runtime state.

The supported initial import maps `/opt/scripts/<relative-path>` to repository `scripts/<relative-path>` and **never overwrites tracked or existing files**.

From a checkout on Ubuntu:

```bash
bash ops/import-opt-scripts.sh --dry-run
bash ops/import-opt-scripts.sh --apply
git status --short
git status --short --untracked-files=all
```

This is a deliberate one-way import, not a scheduled two-way sync or production deployment. It rejects symlinked destination trees, refuses tracked-file overwrites, detects Git-ignored candidates, checks source timestamps/sizes, and publishes copied files without clobbering an existing destination. Conflicts and ignored files need manual review. The script does not stage, commit, push, or delete files.

**Review the content of each imported file for embedded credentials, sensitive data, and machine-specific values before staging it.** The filename exclusions are not a security scanner. Avoid modifying `/opt/scripts/` during import; a filesystem snapshot or maintenance window is required for a strict atomic point-in-time copy.

The `agent-tools/README.md` file is only a placeholder for future reviewed manifests and setup instructions. The repository's existing `agents/` content is an agent registry, not a placeholder for the private `/opt/agents/` runtime.
