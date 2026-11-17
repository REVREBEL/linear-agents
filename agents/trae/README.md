# Trae CLI / Trae Agent

Confirm which product is installed: native Trae CLI is distinct from the separate open-source bytedance/trae-agent. Trae CLI documents `$XDG_CONFIG_HOME/trae_cli/trae_cli.yaml` or `$HOME/.config/trae_cli/trae_cli.yaml`.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `XDG_CONFIG_HOME` | Trae CLI reads this generic XDG root |
| `never redirect globally to Tra` | never redirect globally to Trae |
| `TRAE_CONFIG_FILE` | bytedance/trae-agent Python CLI only, not verified for native Trae CLI |
| `HOME` | Generic fallback home directory |

## References

- https://docs.trae.cn/cli_global-settings
- https://github.com/bytedance/trae-agent/blob/main/trae_agent/cli.py

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
