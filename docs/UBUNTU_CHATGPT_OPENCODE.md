# Ubuntu ChatGPT headless runtime: OpenCode

**Runtime:** OpenCode CLI using the existing ChatGPT/OpenAI OAuth connection.
There is **no** Playwright, browser automation, ChatGPT cookie export,
additional API key, or separate Mac worker. The Ubuntu Linear bridge owns the
Linear app identity, job ledger, session continuity and completion callback.

OpenCode is already installed on the Ubuntu host. Do not reinstall it or
re-authenticate unnecessarily. Confirm the account whose HOME contains the
existing OpenAI/ChatGPT OAuth credentials; the executable and credentials may
belong to a different account than the `bridge` systemd service.

## Production .env

```sh
CHATGPT_HANDOFF_MODE=opencode
OPENCODE_BIN=/home/opencode/.opencode/bin/opencode
# The exact already-authenticated account, ONLY if different from systemd User:
CHATGPT_OPENCODE_USER=opencode
# Select the actual ChatGPT-backed OpenAI model reported by `opencode models openai`:
CHATGPT_OPENCODE_MODEL=openai/REPLACE_WITH_ENABLED_MODEL
```

The `CHATGPT_OPENCODE_USER` example is not proof of which Ubuntu account
currently holds the ChatGPT OAuth connection. Verify it before deployment.
Do not change ownership or copy OAuth credential files. When set, this adapter
uses `sudo -n -H -u <user> -- <OPENCODE_BIN> run ...`; narrowly authorize
this command in sudoers only after review. Without it, execution runs as
the systemd `bridge` account, which must have its own OpenCode login.

The user executing OpenCode must have read/write access to the mapped
`LINUX_PROJECTS_ROOT` checkout and the configured working directory.
OpenCode session data belongs to that user. Restrict model tool permissions
and repository access appropriately. Select the OpenAI provider explicitly
so that an existing local Ollama model is never silently used for ChatGPT jobs.

## Process and state contract

The bridge launches `opencode run --format json --model <openai/model> <prompt>`
in the mapped repository. JSON stream session IDs are stored in the Ubuntu
job ledger. A Linear `prompted` follow-up reuses the previous verified session
through `--session <id>` for the same Linear agent session and workspace.

The OpenCode child receives neither `BRIDGE_SHARED_SECRET` nor personal
Linear keys. When the CLI exits successfully with a textual response, the
Ubuntu bridge posts that response to the ChatGPT Worker's existing
authenticated `/complete` route, then marks its ledger entry completed.
A browser submission, CLI spawn, empty output, or unauthenticated callback
does **not** count as completion. Failures are recorded in the ledger.

This is a headless **CLI agent runtime**, not a remote ChatGPT web conversation
or ChatGPT Work browser handoff. Existing macOS Shortcuts and supervised
browser handoff code remains separate for legacy configurations.
GitHub-review event dispatch is not yet migrated to this runtime.

## Server verification

```bash
sudo -u opencode -H /home/opencode/.opencode/bin/opencode models openai
sudo -u opencode -H /home/opencode/.opencode/bin/opencode run --format json --model "openai/REPLACE_WITH_ENABLED_MODEL" "Respond with: OpenCode online"
```

If `sudo -u opencode` does not match the account that originally signed in,
use the actual account instead. These commands are operator-side verification
steps; repository CI cannot exercise a real authenticated ChatGPT session.
