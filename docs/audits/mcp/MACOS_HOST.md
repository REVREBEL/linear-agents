# ABR-97 — Authenticated dual-host enrollment and macOS routing

**State:** Source-level implementation with verified *read-only* SSH reachability to the real Mac. No new host agent, login item, device certificate, SSH key, launchd unit, process executor, or public MCP route has been activated. ABR-98 and ABR-100 retain the callable MCP tool/profile and end-to-end authorization gates.

## Verified host facts — November 20, 2026

| Source | Verified observation |
| --- | --- |
| Root, `bridge` (UID 994), and `rebel` on Ubuntu | Strict known-host-verified, noninteractive `ssh macos` succeeds for all three |
| Actual macOS target | macOS 15.7.8, Intel x86_64; existing SSH account UID 501 |
| Existing macOS launchd service | `io.revrebel.agent-bridge`, active, same macOS account as all three SSH callers |
| Actual launchd command | `/Users/garystringham/github-revrebel/linear-agents/linear-agent-bridge/start-bridge.sh` and NVM Node v24.19.0 |
| macOS repository | `/Users/garystringham/github-revrebel/linear-agents`, confirmed existing, inside derived `/Users/garystringham/github-revrebel` projects root |
| `OSX_PROJECTS_ROOT` | **Not set** in noninteractive SSH, login shell or `launchctl getenv`. The read-only probe derives the projects root from the validated existing launchd entrypoint and reports `projectRootSource: launchd-repository-parent`. It does **not** write/override a host environment value |
| macOS sandbox process policy | `sandbox-exec` exists, but a read-only network-denied example returned `Operation not permitted`; macOS process execution confinement has not been accepted |
| Ubuntu executor service user | Rootless Bubblewrap for `bridge` still fails under AppArmor namespace policy (ABR-96 deployment blocker). Running Ubuntu test mechanics as root is not service-user acceptance |

All macOS host facts above were obtained via read-only SSH and existing launchd configuration, not by guessing the Mac login, path, default project root, or private keys. `node scripts/mcp-macos-probe.mjs` repeats the same validation using strict SSH options and an internal, fixed Python probe. This can be invoked as any of the three configured Ubuntu SSH accounts.

## Device enrollment and permission architecture

- `device-enrollment.mjs` stores only two canonical host identities: `rebel-server` (Linux paired WS) and `macos-runtime` (Darwin pre-approved SSH). Each device must have an operator-approved pairing challenge, a **new Ed25519 host-key signature** binding the approved workspaces/users/agents/tools/tenant/transport fingerprint, and independently verified OS principal and transport identity. Challenge expires in two minutes, is one-use and cannot be activated with an unknown key.
- Keys are generated and retained by the real host **only after separate operator authorization**. This source implementation generates disposable keys in tests, not on the production Mac or Ubuntu host.
- Device state and audit history persist in SQLite (0700 directory, 0600 database). Operators can list, pause, revoke, re-pair and request key rotation; rotation requires signatures from both old and new private keys. Signed heartbeat proof refreshes last-seen after reconnection. Paused/revoked devices cannot dispatch; device-generation changes invalidate existing session choices even after re-pairing.
- `device-routing.mjs` never derives host authority from `tools/call` arguments. **Interactive** identity and permission sets come from a trusted user-session verifier: a missing approved default/explicit selection yields `DEVICE_SELECTION_REQUIRED` even if one device is online. An offline Mac does not silently fall back to Ubuntu. An explicit authorized user selection of Ubuntu is allowed.
- **Linear** scope is supplied solely by a trusted verified Bridge admission receipt, with current job/session validity rechecked before routing. The existing `chooseExecutionHost` function is reused only after that trusted admission; the default to `bridge-server` is never available to interactive clients. Any conflicting target, tenant, tool, workspace, agent, stale session or generation is denied.
- `macos-host-probe.mjs` confirms host identity via strict known-host SSH and existing launchd configuration without installing or executing an MCP host. It is an **identity discovery step**, not a substitute for signed enrollment or a privileged command grant.

## Testing and integration boundary

`node --test scripts/test-mcp-device-routing.mjs` runs offline two-device signed-pairing fixtures: invalid operator, rejected transport/OS identity and key, replay/expiry, offline/reconnect, pause/revoke/re-enrollment, dual signature rotation, interactive no-default/explicit-choice/no fallback, trusted Linear routing and job liveness, cross-device and tenant checks, stale generations, and Mac discovery validation. GitHub CI runs these without access to an actual SSH target; operator-run canaries use `scripts/mcp-macos-probe.mjs`.

**Required before activation:** operator-approved production host signing/SSH identity and grants; a reviewed trusted adapter from OAuth/session and Linear admission into device routing (ABR-98/99); a separately authorized macOS process/filesystem sandbox (the ABR-94 safe-read module requires Linux `/proc/self/fd` and cannot safely run on Darwin), macOS service agent entrypoint, real two-host execution tests under actual service users, and reconnection/cancellation checks. The source-only launchd candidate in `scripts/macos/launchd` intentionally executes `/usr/bin/false` and is disabled; do not install or start it as a functional MCP host.

The existing Mac `io.revrebel.agent-bridge` launchd service, Ubuntu `agent-bridge.service`, its authoritative `/jobs` ledger, the Synology NAS proxy and Cloudflare routes are untouched by ABR-97.

## Rollback

For a separately authorized future host activation, revoke the corresponding device enrollment generation, stop only the new DesktopCommander host process, and remove only the newly approved launchd unit. Never remove the existing `io.revrebel.agent-bridge` service or reissue previously interrupted Linear jobs. Restoring old keys or a stale session is not an approved rollback.
