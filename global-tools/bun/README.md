# Bun

Bun runtime and global package/cache paths are distinct. Existing zsh file refers to legacy `/opt/bun`.

## Used (confirmed in tracked scripts)

| Variable | Meaning |
|---|---|
| `BUN_INSTALL` | Exported by existing zsh file as /opt/bun |
| `BUN_HOME` | Existing local alias, not documented as authoritative Bun native override |

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `BUN_INSTALL_CACHE_DIR` | Package cache |
| `BUN_INSTALL_GLOBAL_DIR` | Global package directory |
| `BUN_INSTALL_BIN` | Global executable link directory |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH` | Runtime transpile cache |

## References

- https://bun.sh/docs/runtime/bunfig

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
