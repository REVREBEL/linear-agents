# Ubuntu agent execution adapters

The Ubuntu bridge is the only webhook receiver. It owns job deduplication,
project routing, durable status, and Linear completion. Agent-specific launch
contracts live under `linear-agent-bridge/agents/<name>/scripts/`.

| Agent | Launcher | Execution target |
| --- | --- | --- |
| Antigravity | `agents/antigravity/scripts/launch.mjs` | Ubuntu Python `run_agent.py` and native `agy` CLI |
| Gemini | `agents/gemini/scripts/launch.mjs` | Ubuntu native `gemini` CLI, headless |
| Trae | `agents/trae/scripts/launch.mjs` | Mac over authenticated SSH alias `macos` |

Antigravity's existing Python runner remains the execution engine because it
owns the JSON stream, conversation continuation, quota exhaustion handling, and
Worker completion callback. The new Antigravity adapter owns the shell-free
process invocation; it does not replace that existing protocol.

## Linux host setup

Install the CLIs under the same unprivileged account that runs
`agent-bridge.service` (typically `bridge`). Do not mix user-specific
authentication with root or assume that interactive PATH settings apply to
systemd. Verify as the service account:

```bash
sudo -u bridge -H bash -lc 'command -v agy; command -v gemini; command -v python3'
sudo systemctl show agent-bridge.service -p User -p WorkingDirectory -p ExecStart
```

The existing `ANTIGRAVITY_BIN` variable points the Python runner at the
installed `agy` binary (default `~/.local/bin/agy`).
Set `PYTHON_BIN` and `RUN_AGENT_PATH` for the existing Python runner when
needed. Set `GEMINI_BIN` to the trusted absolute CLI path and
`GEMINI_LAUNCH_MODE=headless`. The existing Gemini args template is preserved
to avoid changing approval behavior during relocation.

For a Mac-only Trae desktop launch, set `MAC_SSH_HOST=macos` and
`OSX_PROJECTS_ROOT` to the Mac checkout parent. The SSH identity must work as
the Ubuntu bridge service account. No additional Mac launchd agent is installed.

## Validation boundaries

The added tests verify the selected command/argv, workspace and credential
boundary; they do not authenticate against live Gemini or Antigravity services.
A real Linear issue should verify first-session, follow-up, callback, and
interrupt/recovery behavior before migration cutover.
