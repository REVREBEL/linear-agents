# Mistral Vibe CLI

Existing directory spelling `minstral` is retained pending a naming decision. VIBE_HOME redirects the native Vibe profile, not the installed executable.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `VIBE_HOME` | Vibe native profile root |
| `VIBE_ACTIVE_MODEL` | Default model override |
| `VIBE_STRICT_CONFIG` | Strict config validation |
| `VIBE_TERMINAL_KEY` | Session continuation selector |
| `VIBE_CUSTOM_CONSOLE_URL` | Pinned login console |
| `VIBE_<KEY>` | Top-level config override (nested keys via __) |
| `MISTRAL_API_KEY` | Credentials via 1Password |

## References

- https://docs.mistral.ai/vibe/code/cli/configuration-reference

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
