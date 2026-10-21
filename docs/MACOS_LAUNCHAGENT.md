# macOS LaunchAgent setup

The `<reverse-DOMAIN>.agent-bridge` LaunchAgent starts the local Linear bridge at login and restarts it when it exits.

## Template placeholders

[`scripts/macos/agent-bridge.plist.example`](../scripts/macos/agent-bridge.plist.example) is a valid XML property list **template**. Its `__REPO_ROOT__` and `__LAUNCHAGENT_LABEL__` tokens are not macOS or `launchd` variables: they are replacement markers consumed by [`scripts/macos/install-launchagent.sh`](../scripts/macos/install-launchagent.sh). Do **not** copy the unrendered template into `~/Library/LaunchAgents`.

The installer reads `DOMAIN` from the trusted root `.env`, reverses its DNS labels (for example, `example.com` becomes `com.example.agent-bridge`), and uses that value for both the service label and plist filename. It discovers the absolute repo location, expands the template markers, checks the XML with `plutil -lint`, backs up any existing plist, and writes a valid plist to `~/Library/LaunchAgents/<reverse-DOMAIN>.agent-bridge.plist`. It does **not** restart the service. Before writing the plist, it installs the shared root npm workspace dependencies and sets up the bridge-local Python virtual environment.

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
ls ~/Library/LaunchAgents/*agent-bridge.plist
# Inspect the generated plist that matches your DOMAIN.
```

The bridge wrapper exports `REPO_ROOT` and sources the trusted local `.env`. In particular, confirm `ROUTING_CONFIG_FILE` points to the actual routing JSON. The central example still requires configuring that file and all mandatory secret values.

**Migration from an existing install:** If your previous service has a different label, installing the new plist does **not** unload or replace the old service. Unload and remove the old plist only after recording its settings and verifying the replacement, to avoid two bridges competing for port 8788. Stop active agent jobs first. The installer backs up your current plist but writes a replacement that launches the bridge from the **current Git checkout**, not an older `~/.linear-agent-bridge` copy. Before loading the replacement, verify the required Node.js executable, Python environment, Antigravity runner, Gemini and Trae binaries, routing file, and the root `.env` file all work from this checkout.

The old `EnvironmentVariables` dictionary should not be carried forward after equivalent values are set in `.env`. Do not put API tokens or the bridge shared secret in the plist.

## Node.js workspace dependencies

The installer runs `npm ci` from the detected repository root, installing the shared npm workspaces using the committed `package-lock.json`. It checks for `node` and `npm` on `PATH`, and verifies the root Wrangler executable exists after installation. This requires access to the npm registry unless the dependencies are already cached. Installation failure stops setup **before** replacing the LaunchAgent plist. You do not need to run `npm install` separately for the standard macOS setup. `npm ci` does not deploy any Cloudflare Workers; deployments and Worker secrets remain separately managed.

For local development outside the installer, `npm install` remains available to update dependencies, while `npm ci` reproduces the lockfile.

## Python runner environment

The installer automatically creates `linear-agent-bridge/.venv` using `python3 -m venv` and installs dependencies from `linear-agent-bridge/requirements.txt` (currently `requests`). It reuses an existing environment and refreshes requirements on subsequent runs. Python **3.10 or newer** is required. The runtime already defaults to `linear-agent-bridge/.venv/bin/python` and `linear-agent-bridge/run_agent.py`, so neither `PYTHON_BIN` nor `RUN_AGENT_PATH` is needed in `.env`. If a prior `.env` still contains an old `PYTHON_BIN` override, remove it before running the installer. The installer refuses conflicting overrides rather than silently using the wrong Python executable.

The installer requires network access to install any missing Python packages; failure stops installation before replacing the plist. It does not move or remove an older `~/.linear-agent-bridge/.venv`.

## Load or reload

The installer prints ready-to-run `launchctl` commands with the **actual** domain-derived service label and plist path. Copy those commands from the installation output after reviewing the generated plist. The installer does not execute them automatically. Stop active agent jobs before restarting the bridge.

For reference, the following uses `DOMAIN=example.com`:

```bash
SERVICE="gui/$(id -u)/com.example.agent-bridge"
PLIST="$HOME/Library/LaunchAgents/com.example.agent-bridge.plist"

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

- `DOMAIN` must be set in `.env` to a valid DNS name before running the installer. Never include a hardcoded company domain in the reusable template.
- `launchd` does not expand `$HOME`, `${REPO_ROOT}`, or `~` in a plist's `ProgramArguments`. The installer substitutes a real absolute path.
- Executing `node agent-bridge.mjs` directly does not load the root `.env`. Use `bash scripts/with-env.sh bridge` or launch through the installed plist.
- Changes to `.env` require restarting the service; `launchd` does not monitor the file.
- Keep `.env` ignored by Git, protect it with appropriate permissions (e.g. `chmod 600 .env`) and rotate previously exposed shared secrets.
- Do not run two bridges bound to port `8788` concurrently. A checkout upgrade is separate from updating Cloudflare Workers and routing config.
