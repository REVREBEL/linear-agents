# OpenChamber

OpenChamber data/config is distinct from OpenCode's agent state. Its executable belongs in shared tools.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `OPENCHAMBER_DATA_DIR` | Native application data root |
| `OPENCHAMBER_CHATS_DIR` | Managed chats root |
| `OPENCHAMBER_UI_PASSWORD` | UI credential via 1Password |
| `OPENCHAMBER_COMPRESS_API` | Compression control |
| `OPENCHAMBER_SKIP_API_COMPRESSION` | Disable API compression |
| `OPENCHAMBER_VERBOSE_REQUEST_LOGS` | HTTP diagnostics |
| `OPENCHAMBER_PACKAGE_MANAGER` | Package manager selection |
| `HTTP_PROXY` | Proxy routing if required |
| `HTTPS_PROXY` | Proxy routing if required |
| `NO_PROXY` | Proxy bypass |

## References

- https://docs.openchamber.dev/environment/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
