# macOS LaunchAgent setup

The `io.revrebel.agent-bridge` LaunchAgent starts the local Linear bridge at login and restarts it when it exits.

## Template placeholders

[`scripts/macos/io.revrebel.agent-bridge.plist.example`](../scripts/macos/io.revrebel.agent-bridge.plist.example) is a valid XML property list **template**. Its `__REPO_ROOT__` token is not a macOS or `launchd` variable: it is a replacement marker consumed by [`scripts/macos/install-launchagent.sh`](../scripts/macos/install-launchagent.sh). Do **not** copy the unrendered template into `~/Library/LaunchAgents`.

The installer discovers the absolute repo location, expands all `__REPO_ROOT__` markers, checks the XML with `plutil -lint`, backs up any existing plist, and writes a valid plist to `~/Library/LaunchAgents/io.revrebel.agent-bridge.plist`. It does **not** restart the service.

The template uses:

- `/bin/bash` to invoke `scripts/with-env.sh bridge`
- checkout root for `WorkingDirectory`
- `linear-agent-bridge/bridge.log` and `bridge-error.log` for logging
- `RunAtLoad` and `KeepAlive` to supervise the bridge
- **No `EnvironmentVariables` dictionary**: the wrapper loads values from the local root `.env`

These defaults work regardless of whether the repo is cloned into `linear-agents/`, `.linear-agents/`, or another directory.

## Install

```bash
cd /path/to/linear-agents
cp .env.example .env  # only if you have not already created .env
# Fill in .env, including BRIDGE_SHARED_SECRET, PROJECTS_ROOT and executable paths.
bash scripts/macos/install-launchagent.sh
plutil -p ~/Library/LaunchAgents/io.revrebel.agent-bridge.plist
```

The bridge wrapper exports `REPO_ROOT` and sources the trusted local `.env`. In particular, confirm `ROUTING_CONFIG_FILE` points to the actual routing JSON. The central example still requires configuring that file and all mandatory secret values.

**Migration from an existing install:** stop active agent jobs first. The installer backs up your current plist but writes a replacement that launches the bridge from the **current Git checkout**, not an older `~/.linear-agent-bridge` copy. Before loading the replacement, verify the required Node.js executable, Python environment, Antigravity runner, Gemini and Trae binaries, routing file, and the root `.env` file all work from this checkout.

The old `EnvironmentVariables` dictionary should not be carried forward after equivalent values are set in `.env`. Do not put API tokens or the bridge shared secret in the plist.

## Load or reload

```bash
SERVICE="gui/$(id -u)/io.revrebel.agent-bridge"
PLIST="$HOME/Library/LaunchAgents/io.revrebel.agent-bridge.plist"

# Stops an existing service. A 'not loaded' error is okay for first installs.
launchctl bootout "gui/$(id -u)" "$PLIST" || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "$SERVICE"
curl -fsS http://127.0.0.1:8788/health
```

If the service repeatedly restarts, inspect:

```bash
tail -n 100 /path/to/linear-agents/linear-agent-bridge/bridge-error.log
tail -n 100 /path/to/linear-agents/linear-agent-bridge/bridge.log
```

The health response must indicate `ok: true`, the intended `projectsRoot`, and `hasBridgeSharedSecret: true`. This does **not** by itself prove an end-to-end Linear webhook or agent launch works.

## Common pitfalls

- `launchd` does not expand `$HOME`, `${REPO_ROOT}`, or `~` in a plist's `ProgramArguments`. The installer substitutes a real absolute path.
- Executing `node agent-bridge.mjs` directly does not load the root `.env`. Use `bash scripts/with-env.sh bridge` or launch through the installed plist.
- Changes to `.env` require restarting the service; `launchd` does not monitor the file.
- Keep `.env` ignored by Git, protect it with appropriate permissions (e.g. `chmod 600 .env`) and rotate previously exposed shared secrets.
- Do not run two bridges bound to port `8788` concurrently. A checkout upgrade is separate from updating Cloudflare Workers and routing config.
