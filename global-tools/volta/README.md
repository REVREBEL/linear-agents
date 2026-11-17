# Volta

Volta manages shared Node.js installations and shims. Existing scripts and zsh configuration still reference legacy `/opt/volta`.

## Used (confirmed in tracked scripts)

| Variable | Meaning |
|---|---|
| `VOLTA_HOME` | Configured in existing installation script and zsh file to /opt/volta |

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `VOLTA_FEATURE_PNPM` | Enable pnpm support |
| `VOLTA_LOGLEVEL` | Diagnostics |
| `PATH` | Includes VOLTA_HOME/bin for shims |

## References

- https://docs.volta.sh/advanced/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
