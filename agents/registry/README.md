# Agent runtime registry

Internal Bridge metadata only, not a separately installed CLI. Tracked staging script uses `/opt/agents/registry/agent-runtimes.json`; no documented vendor-native variables apply.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `PATH` | Generic command search path, not registry config |
| `HOME` | Generic process home, not registry config |
| `XDG_CONFIG_HOME` | Generic process config root, not registry config |

## References

- https://github.com/REVREBEL/linear-agents/blob/infrastructure/scripts/15-stage-agent-runtime-registry.sh

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
