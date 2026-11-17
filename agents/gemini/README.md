# Antigravity CLI (AGY)

The existing folder is named gemini, but this is now the Antigravity CLI (`agy`) profile. AGY documents settings in `~/.gemini/antigravity-cli/settings.json`. Do not assume legacy Gemini CLI's `GEMINI_CLI_HOME` applies to AGY.

## Used (confirmed in tracked scripts)

None confirmed in the committed configuration for this component. This does **not** establish the live environment.

## Additional supported variables (not configured here)

| Variable | Meaning |
|---|---|
| `AGY_ADC_AUTH` | Optional ADC auth selection |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | Disable self-updates |
| `GEMINI_API_KEY` | Provider key when modelProvider=gemini, supply via 1Password |
| `GOOGLE_GEMINI_BASE_URL` | Custom Gemini-compatible endpoint |
| `GOOGLE_CLOUD_QUOTA_PROJECT` | ADC quota project |
| `GOOGLE_CLOUD_LOCATION` | ADC location |
| `GEMINI_CLI_HOME` | Gemini CLI only, not confirmed for AGY |
| `HOME` | Generic process-wide home, not AGY-specific |

## References

- https://antigravity.google/docs/cli/using
- https://antigravity.google/docs/cli/install
- https://antigravity.google/docs/cli/troubleshooting

## Migration status

Documentation only. No executable symlinks, installed paths, runtime exports, profile files, or existing `.config`, `.cache`, or `.local` directories are changed. New credentials continue to come from 1Password.
