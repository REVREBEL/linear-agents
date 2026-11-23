# Ubuntu Bridge system setup and candidate units

Existing `install-systemd.sh`, `install-github-event-publisher.sh`, and `bridge.sh` manage the independently deployed canonical Bridge components. None of them install the ABR-96 source-only MCP executor.

The [ABR-96 candidate unit](systemd/desktopcommander-mcp-host-agent.service.example) is **deliberately non-startable**, with `User=bridge`, an opt-in approval marker condition, strict namespace readiness preflight, systemd cgroup teardown, and `ExecStart=/usr/bin/false` until the separately reviewed ABR-97 host agent exists. Do not copy to /etc/systemd/system or enable it; the real service-user namespace policy now passes on the reviewed host; this does not activate the source-only candidate unit.

See [ABR-96 executor and OS policy gate](../../docs/audits/mcp/EXECUTOR.md) and `scripts/mcp-executor-probe.mjs --strict` before any future approved deployment. Existing systemd installations and `agent-bridge.service` are out of scope.

## ABR-17 M5: approved Bubblewrap policy

The installed `agent-bridge-bwrap-policy.service` loads only Ubuntu's packaged
`/etc/apparmor.d/bwrap-userns-restrict`, including the restricted child profile.
The reviewed unit is [here](systemd/agent-bridge-bwrap-policy.service.example).
On the approved host the general AppArmor profile loader was inactive, so
loading the specific packaged policy was sufficient to resolve namespace denial.
Do not disable namespace restrictions globally, install a custom allow-all
profile, or run Bridge as root. The existing Bridge service was restarted later
for the shared Volta path migration documented below.

For the same approved Ubuntu host, verify the packaged file and parser
compatibility before installing this example as a root-owned 0644 unit under
/etc/systemd/system, then daemon-reload and enable/start the policy unit.
Run the strict existing sandbox probe using the actual service UID and installed
Node executable; use a private service-owned TMPDIR for tests if /tmp is not
writable. Do not change system-wide temporary-directory permissions as a test fix.
Rollback only after draining dependent managed jobs: disable the dedicated
policy unit; if separately authorized, unload just the packaged bwrap profiles
with apparmor_parser -R after confirming no dependent process needs them.
Do not unload Docker or unrelated AppArmor profiles.


## Shared Volta and Kilo path routing

The Bridge host uses `/opt/global-tools/volta` as the single shared Volta home.
`agent-bridge.service` sets `VOLTA_HOME=/opt/global-tools/volta` and puts
`/opt/global-tools/volta/bin` first in `PATH`. The GitHub event publisher
installer emits the same shared Volta path. Do not create a second Volta home
inside `/home/bridge/agent-bridge`.

The checkout paths `/home/bridge/agent-bridge/.volta` and `.kilo` are host
symlinks to `/opt/global-tools/volta` and `/opt/agents/kilo/.kilo` respectively.
The home-level routes `/home/bridge/.volta` and `/home/bridge/.kilo` point to
those same canonical locations. Keep Kilo agent definitions under
`/opt/agents/kilo/.kilo/agents`; the checkout excludes both host symlinks from
Git. See [the shared runtime path reference](../../docs/operations/shared-runtime-paths.md).
