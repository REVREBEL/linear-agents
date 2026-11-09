# Agent Location routing: Ubuntu dispatcher + macOS over SSH

The Ubuntu bridge remains the only Linear webhook receiver, job ledger, and Cloudflare Tunnel origin. The Linear issue's **agent-location** group chooses execution location. No SCP or second bridge process is needed.

## Ubuntu .env

```sh
PROJECTS_ROOT="/home/agent-bridge/rebel"
LINUX_PROJECTS_ROOT="/home/agent-bridge/rebel"
OSX_PROJECTS_ROOT="/Users/garystringham/github-revrebel"
MAC_SSH_HOST="mac-agent"
# Optional when SSH sessions do not have node in PATH:
# MAC_NODE_BIN="/Users/garystringham/.volta/bin/node"
# Optional if the Mac checkout lives elsewhere:
# MAC_RUNNER_PATH="/Users/garystringham/github-revrebel/linear-agents/scripts/macos/remote-agent-runner.mjs"
# Optional: MAC_TRAE_BIN="/path/to/trae"
```

`LINUX_PROJECTS_ROOT` takes precedence over legacy `PROJECTS_ROOT` and any `routing.json.projectsRoot` on Ubuntu. Without it, the existing config continues to work. The Mac path is **never checked on Ubuntu**; the Mac validates its real checkout and scope when the SSH request arrives.

`routing.json` still maps Linear project and initiative UUIDs to approved REVREBEL repository identities and optional project scopes. Remote delivery sends the repository name, scope and Mac project root over SSH stdin. It never copies a repository, runs a command assembled from issue text, or writes token-bearing job payloads to disk.

## Deploy to both computers

1. Fetch this branch onto **both Ubuntu and Mac**: the Mac requires `scripts/macos/remote-agent-runner.mjs` at the configured path, and Ubuntu requires the bridge code and updated Worker deployments.
2. Enable macOS Remote Login for the dedicated SSH user and configure the Ubuntu bridge service account's `~/.ssh/config` alias `mac-agent`, key-based authentication and a pinned known_hosts entry. Validate with `ssh -o BatchMode=yes mac-agent 'uname -s'` (expected `Darwin`).
3. Ensure macOS SSH can find Node and the Trae CLI. Configure `MAC_NODE_BIN` and `MAC_TRAE_BIN` on Ubuntu if necessary.
4. Deploy **all five** updated Linear Workers, since they query issue labels as well as project mapping.
5. Restart only the Ubuntu `agent-bridge.service` after a successful build and tests. Do not run a second Linear web listener on the Mac.
6. Assign Trae in Linear with **agent-location → macos** and confirm the bridge ledger records `executionHost: macos` after remote ACK. Test **bridge-server** for local Ubuntu routing.

## Operational safeguards and current scope

- Mac dispatch currently supports **Trae only**. An explicit Mac label for another agent fails closed with a clear error; no silent Ubuntu fallback.
- An issue without Agent Location continues to use Ubuntu.
- SSH has a 10-second connect timeout, strict host-key checking, no interactive password prompts, and a 20-second remote acceptance timeout.
- The Mac validates that the real checkout and scope are inside its configured root before starting Trae. If SSH dies before ACK, the ledger records failure. Interrupted work is **not automatically replayed** because an agent may have already made changes.
- Trae's CLI must run in the SSH user's macOS session. GUI-specific behavior may require an interactive logged-in desktop session. A successful SSH authentication alone does not guarantee Trae GUI availability.
- The remote CLI process exit is recorded centrally; **Linear agent-session completion still follows the existing separate completion/activity contract** and should be end-to-end verified before broad rollout.
- The bridge must be able to fetch the Trae app's short-lived token from the Worker. It delivers it only inside the encrypted SSH stdin payload; Mac task files omit the token.
