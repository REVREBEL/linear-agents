# Python virtual environments

venv is a Python facility; each project environment is independent and should not be globally selected with VIRTUAL_ENV.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `VIRTUAL_ENV` | Activation metadata, not a venv creation switch |
| `PYTHONUSERBASE` | User-site installation base |
| `PYTHONPYCACHEPREFIX` | Compiled Python bytecode cache |
| `PYTHONPATH` | Extra module search path, avoid broad global use |
| `PIP_CONFIG_FILE` | pip config file |
| `UV_PROJECT_ENVIRONMENT` | uv project-specific environment override |

## References

- https://docs.python.org/3/library/venv.html

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
