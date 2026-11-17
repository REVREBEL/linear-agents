# Yarn

Yarn Classic and modern Yarn differ; verify installed version before enabling variable overrides.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `YARN_CACHE_FOLDER` | Cache override supported in compatible releases |
| `YARN_GLOBAL_FOLDER` | Global folder in compatible releases |
| `YARN_RC_FILENAME` | Config filename |
| `YARN_ENABLE_GLOBAL_CACHE` | Modern Yarn global cache switch |
| `YARN_HOME` | Not a documented universal home override like VOLTA_HOME |

## References

- https://yarnpkg.com/configuration/yarnrc

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
