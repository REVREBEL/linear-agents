# Kilo CLI

KILO_CONFIG_DIR augments config discovery; it does not relocate every cache or session. Executable belongs to global tools.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `KILO_CONFIG_DIR` | Additional config directory |
| `KILO_CONFIG` | Additional config file |
| `KILO_CONFIG_CONTENT` | Inline JSON configuration |
| `KILO_ORG_ID` | Organization selection |
| `XDG_CONFIG_HOME` | Generic shared config root, not safe to point globally to Kilo |

## References

- https://kilo.ai/docs/contributing/architecture/cli-runtime

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
