# npm

npm configuration, cache, and Volta-managed global binaries are distinct.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `NPM_CONFIG_CACHE` | npm download cache |
| `NPM_CONFIG_USERCONFIG` | User npmrc path |
| `NPM_CONFIG_GLOBALCONFIG` | Global npmrc path |
| `NPM_CONFIG_PREFIX` | Global install prefix (can conflict with Volta) |
| `NPM_CONFIG_REGISTRY` | Registry endpoint |

## References

- https://docs.npmjs.com/cli/v11/using-npm/config

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
