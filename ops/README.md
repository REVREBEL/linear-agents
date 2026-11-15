# Ubuntu /opt script import

The existing bridge remains in `linear-agent-bridge/`. The repository already has a `scripts/` directory containing bridge tooling, so the import utility **never overwrites existing files**.

On the Ubuntu host, from a checkout of this repository:

```bash
bash ops/import-opt-scripts.sh --dry-run
bash ops/import-opt-scripts.sh --apply
git status --short
git diff --no-index /dev/null scripts/YOUR_NEW_SCRIPT.sh  # example manual review
```

The helper maps server `/opt/scripts/<relative-path>` to repository `scripts/<relative-path>`. It is deliberately a **one-way, explicit import**, not a background two-way sync or production deployment. It does not remove files, follow symlinks, overwrite conflicts, stage, commit, or push. It skips hidden files and filenames commonly associated with secrets/runtime data; this is **not a content security scan**. Review every imported file for secrets and machine-specific data before committing.

For the initial setup, only README placeholders are versioned in `agents/` and `agent-tools/`; no live agent profiles or tool binaries are included.
