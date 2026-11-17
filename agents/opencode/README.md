# OpenCode

OPENCODE_CONFIG_DIR chooses additional config search; it does not move all native state. Keep binary and profile separate.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `OPENCODE_CONFIG_DIR` | Config lookup directory |
| `OPENCODE_CONFIG` | Specific config file |
| `OPENCODE_CONFIG_CONTENT` | Inline config |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Disable project config discovery |
| `OPENCODE_DB` | DB path when supported by installed version, verify before use |
| `OPENCODE_SERVER_PASSWORD` | HTTP server secret from 1Password |
| `XDG_CONFIG_HOME` | Shared XDG setting, not a global OpenCode profile variable |

## References

- https://opencode.ai/docs/config
- https://opencode.ai/docs/cli

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
