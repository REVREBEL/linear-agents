# snapd

Snap data variables are managed by snapd when launching a snap. Do not export them as global overrides into `/opt/global-tools`.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `SNAP` | Snap mount |
| `SNAP_DATA` | Revision data |
| `SNAP_COMMON` | Shared system snap data |
| `SNAP_USER_DATA` | Per-user revision data |
| `SNAP_USER_COMMON` | Per-user cross-revision data |
| `SNAP_REAL_HOME` | Original user home as supplied by snapd |

## References

- https://snapcraft.io/docs/reference/development/environment-variables/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
