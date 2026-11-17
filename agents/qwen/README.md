# Qwen Code CLI

QWEN_HOME is Qwen's native configuration/profile root; runtime and conversations directories have separate overrides.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `QWEN_HOME` | Native profile including settings, memory and skills |
| `QWEN_RUNTIME_DIR` | Logs and session records |
| `QWEN_CONVERSATIONS_DIR` | qwen serve conversations workspace |
| `QWEN_SANDBOX` | Sandbox selection, review before use |
| `QWEN_SANDBOX_IMAGE` | Sandbox image |
| `QWEN_CODE_LEGACY_MCP_BLOCKING` | Legacy synchronous MCP handshake |

## References

- https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
