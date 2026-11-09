# Agent Location routing: Ubuntu dispatcher + macOS over SSH

The Ubuntu bridge remains the only Linear webhook receiver, job ledger, and Cloudflare Tunnel origin. Agent-specific commands live under `linear-agent-bridge/agents/<agent>/scripts/`, not in the generic bridge SSH dispatcher. The Trae script invokes the existing desktop CLI with `chat --reuse-window --maximize` from the selected Mac repository. No extra `launchctl` job is installed. The Linear issue's **agent-location** group chooses execution location. No SCP or second bridge process is needed.

## Ubuntu .env

```sh
PROJECTS_ROOT="/home/agent-bridge/rebel"
LINUX_PROJECTS_ROOT="/home/agent-bridge/rebel"
OSX_PROJECTS_ROOT="/Users/garystringham/github-revrebel"
MAC_SSH_HOST="macos"
# Optional when SSH sessions do not have node in PATH:
# MAC_NODE_BIN="/Users/garystringham/.volta/bin/node"
# Optional if the Mac checkout lives elsewhere:
# MAC_RUNNER_PATH="/Users/garystringham/github-revrebel/linear-agents/linear-agent-bridge/agents/trae/scripts/launch.mjs"
# Optional: MAC_TRAE_BIN="/path/to/trae"
```

`LINUX_PROJECTS_ROOT` takes precedence over legacy `PROJECTS_ROOT` and any `routing.json.projectsRoot` on Ubuntu. Without it, the existing config continues to work. The Mac path is **never checked on Ubuntu**; the Mac validates its real checkout and scope when the SSH request arrives.

`routing.json` still maps Linear project and initiative UUIDs to approved REVREBEL repository identities and optional project scopes. Remote delivery sends the repository name, scope and Mac project root over SSH stdin. It never copies a repository, runs a command assembled from issue text, or writes token-bearing job payloads to disk.

## Deploy to both computers

1. Fetch this branch onto **both Ubuntu and Mac**: the Mac requires `linear-agent-bridge/agents/trae/scripts/launch.mjs` at the configured path, and Ubuntu requires the bridge code and updated Worker deployments.
2. Enable macOS Remote Login for the dedicated SSH user and configure the Ubuntu bridge service account's `~/.ssh/config` alias `macos`, key-based authentication and a pinned known_hosts entry. Validate with `ssh -o BatchMode=yes macos 'uname -s'` (expected `Darwin`).
3. Ensure macOS SSH can find Node and the Trae CLI. Configure `MAC_NODE_BIN` and `MAC_TRAE_BIN` on Ubuntu if necessary.
4. Deploy **all five** updated Linear Workers, since they query issue labels as well as project mapping.
5. Restart only the Ubuntu `agent-bridge.service` after a successful build and tests. Do not run a second Linear web listener on the Mac.
6. Assign Trae in Linear with **agent-location → macos** and confirm the bridge ledger records `executionHost: macos` after remote ACK. Test **bridge-server** for local Ubuntu routing.

## Operational safeguards and current scope

- Mac dispatch currently supports **Trae only**. The old `scripts/macos/remote-agent-runner.mjs` path remains a compatibility shim; new dispatch uses `linear-agent-bridge/agents/trae/scripts/launch.mjs`. An explicit Mac label for another agent fails closed with a clear error; no silent Ubuntu fallback.
- An issue without Agent Location continues to use Ubuntu.
- SSH has a 10-second connect timeout, strict host-key checking, no interactive password prompts, and a 20-second remote acceptance timeout.
- The Mac validates that the real checkout and scope are inside its configured root before starting Trae. If SSH dies before ACK, the ledger records failure. Interrupted work is **not automatically replayed** because an agent may have already made changes.
- Trae's CLI must run in the SSH user's macOS session. GUI-specific behavior may require an interactive logged-in desktop session. A successful SSH authentication alone does not guarantee Trae GUI availability.
- The remote CLI process exit is recorded centrally; **Linear agent-session completion still follows the existing separate completion/activity contract** and should be end-to-end verified before broad rollout.
- The bridge must be able to fetch the Trae app's short-lived token from the Worker. It delivers it only inside the encrypted SSH stdin payload; Mac task files omit the token.

## Mac Trae progress and explicit completion

The macOS Trae hook no longer assumes the central bridge listens on Mac loopback.
For SSH-routed jobs, Ubuntu generates a random per-job capability token and
retains only its SHA-256 hash in the job ledger. The Mac stores the token and the
callback URLs in the mode-0600 repository-local
`.linear-agent/trae-active-session.json` context. Git excludes `.linear-agent/`.
The bridge-wide `BRIDGE_SHARED_SECRET` is never given to the Mac hook.

The Mac reports sanitized progress to
`https://trae-agent.revrebel.io/trae-activity`. Ubuntu verifies the token,
job key, session ID, workspace, and non-terminal job state from its ledger
before forwarding activity to the trusted Trae Worker `/complete` route.
The configured Trae Worker completion URL is restricted to its expected HTTPS
Worker host.

**Network prerequisite:** Cloudflare Tunnel and WAF rules must permit the
authenticated `POST /trae-activity` and `POST /trae-complete` routes on
the Trae Tunnel host. Never allow these paths to bypass the token validation
in the Ubuntu bridge. Test from Mac before production cutover. No new daemon
or Mac LaunchAgent is installed.

A Trae `Stop` hook only reports progress, not task completion. When the
agent has verified the work and is ready to finish its Linear session, invoke
the explicit script from within the selected repository:

```bash
node /Users/garystringham/github-revrebel/linear-agents/linear-agent-bridge/agents/trae/scripts/complete.mjs completed "Implementation tested and ready for review"
```

For an actual failure, pass `failed` and a brief error explanation. The
script reads its session context from the current repository, sends the
per-job capability token over HTTPS, and Ubuntu posts a terminal Agent Activity
to the Worker before recording a confirmed ledger completion.

The earlier Mac CLI exit is **not** treated as proof of completion. SSH
closure leaves the ledger `awaiting_external` unless terminal completion
has already been confirmed. The explicit completion script is currently a
manual/agent-invoked contract; a live Trae desktop cycle has not been tested.

## Trae callback deployment contract (Ubuntu)

Both callback routes are handled by `linear-agent-bridge/agent-bridge.mjs`,
not by the `linear-trae-worker` custom domain. The existing Trae Tunnel
hostname must forward **all** paths, including these, to the same local Ubuntu
listener as `/jobs`:

| Public destination | Target |
| --- | --- |
| `https://trae-agent.revrebel.io/trae-activity` | `http://127.0.0.1:8788/trae-activity` |
| `https://trae-agent.revrebel.io/trae-complete` | `http://127.0.0.1:8788/trae-complete` |

**No separate Worker route, reverse proxy, or Mac service is required** if
the existing Tunnel hostname already forwards paths unconditionally.
The repository's Terraform does **not** currently manage Cloudflare Tunnel
ingress or DNS. Check the active Tunnel configuration before deployment.
Do not create another Tunnel or overwrite the existing one.

The opted-in Terraform-managed zone WAF ruleset includes a POST-only block rule
for these two paths. It is not deployed automatically: the
`manage_linear_webhook_waf` toggle defaults to false, because Terraform's
zone ruleset is authoritative and could overwrite unrelated existing policies.
When an existing WAF ruleset is present, reconcile/import it first and preserve
every existing rule and its ordering. An additional WAF exception may be needed
if an existing zone-wide block rule catches the Trae callback POSTs. Keep the
capability-token checks in Ubuntu as the primary application authentication.

After deploying the new Ubuntu bridge, run:

```bash
npm run bridge:check-trae-routes
```

The non-mutating probe sends JSON `{}` over POST to each route. It expects the
exact Ubuntu errors: `400 Invalid Trae workspace` from `/trae-activity`, and
`401 Invalid completion context` from `/trae-complete`. A challenge, redirect,
404, unexpected success, or wrong JSON error fails the test. This verifies
public reachability and denial of unauthenticated requests, not that a valid
Mac capability token reaches Linear. Run a controlled Trae session afterward.

**Deployment order:** deploy Ubuntu bridge code; confirm Tunnel's Trae origin
points to the Ubuntu listener; review any existing Cloudflare WAF exceptions;
run this unauthenticated route check; then test live authenticated Mac hooks.
The Worker itself needs no new callback route because it only receives the
existing `/complete` request from Ubuntu.
