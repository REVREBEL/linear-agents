# uv

uv supports separate roots for installed tools, launcher links, managed Python, cache and config. Existing installer references legacy `/opt/uv`.

## Used (confirmed in tracked scripts)

| Variable | Meaning |
|---|---|
| `UV_TOOL_DIR` | Suggested in tracked installer, not verified in live environment |
| `UV_CACHE_DIR` | Suggested in tracked installer, not verified in live environment |

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `UV_TOOL_BIN_DIR` | Tool command links |
| `UV_PYTHON_INSTALL_DIR` | Managed Python installations |
| `UV_CONFIG_FILE` | Config file |
| `UV_PROJECT_ENVIRONMENT` | Project-specific venv: do not export globally |
| `UV_PYTHON_BIN_DIR` | Managed Python command links |
| `UV_NO_CACHE` | Disable cache |

## References

- https://docs.astral.sh/uv/reference/environment/

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
