# PM2

PM2 executable and PM2_HOME state are different. Changing the PM2_HOME of a running daemon may address a different registry; no migration applied.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `PM2_HOME` | PM2 daemon logs, sockets and process registry |
| `PM2_LOG_DATE_FORMAT` | Daemon log timestamp format |
| `NODE_ENV` | Managed application mode, not PM2 home |
| `PM2_PUBLIC_KEY` | PM2 Plus key if used, via 1Password |
| `PM2_SECRET_KEY` | PM2 Plus key if used, via 1Password |

## References

- https://pm2.keymetrics.io/docs/usage/environment/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
