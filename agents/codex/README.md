# Codex CLI

CODEX_HOME selects the native Codex config/session/skills root directly. The executable is installed independently and a local launcher symlink is planned.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `CODEX_HOME` | Native Codex profile root (candidate: /opt/agents/codex) |
| `CODEX_API_KEY` | API-key authentication in supported contexts, inject through 1Password |
| `OPENAI_API_KEY` | API credential for supported integrations, never check into Git |

## References

- https://developers.openai.com/codex/config-basic
- https://developers.openai.com/codex/auth

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
