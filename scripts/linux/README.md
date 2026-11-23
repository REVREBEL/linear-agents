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

## Shared Volta installer preflight

Both systemd installers source `shared-volta-preflight.sh` before writing units.
The preflight requires the canonical `/opt/global-tools/volta` directory,
executable `volta` and `node` shims, and at least one installed Node binary
that the `bridge` service account can execute. Missing or unusable runtimes
cause installation to stop before any unit file is written or replaced.
Print-only mode remains available without a host Volta installation.

## ABR-59 M14 sealed Bridge launch

`scripts/linux/launch-sealed-bridge.sh` and the reviewed
`systemd/agent-bridge.service` provide the operator-controlled migration
from bridge-writable source to a separately reviewed, root-owned Git release.
The launcher reads **only** `/etc/agent-bridge/bridge.env` (root:bridge 0640),
clears executable loader injection variables, uses `/usr/bin/node`, and binds
the existing Bridge job-state/agent workspace with
`BRIDGE_RUNTIME_PROJECT_DIR`. Neither source file deploys or restarts the
service. Preserve the existing writable job state for rollback.

### Preflight, canonical service identity, and Node provenance

Install the reviewed `scripts/linux/systemd/agent-bridge.service` **under
`/etc/systemd/system/agent-bridge.service`**, replacing the pre-approved
service unit under that same name. The root memory authority authenticates
`agent-bridge.service`'s MainPID, cgroup and start ticks; do not deploy a
separate `agent-bridge-sealed.service` identity.

Before deployment, run `launch-sealed-bridge.sh --preflight` as the Bridge
user to check the sealed environment, the exact existing canonical runtime
symlink target (`/opt/workspaces/linear-agents/linear-agent-bridge`),
and at least one prior `linear-jobs/job-state/*/state.json`. An absent,
replaced or empty ledger causes startup refusal; the launcher cannot initialize
a new empty ledger under an alternate directory. Preflight exits without
reading secret values or starting Node.

The unit strips `BASH_ENV`, `ENV`, `SHELLOPTS` and `BASHOPTS` before Bash
starts; the launcher uses absolute `/usr/bin` paths for preflight utilities
to avoid PATH-injected replacements. The executable remains root-owned
`/usr/bin/node` (Node 22.22.1 verified on production), not the agent-writable
Volta shim at `/opt/global-tools/volta/bin/node`. The sealed launcher requires
system Node 20+ and fails closed without it; Volta remains available to
regular agent CLI processes.

### November 23 workspace relocation

The live Bridge workspace is now physically located at
`/opt/workspaces/linear-agents`, and `/home/bridge/agent-bridge` is a
root-owned compatibility symlink. The reviewed launcher pins the **actual**
`/opt/workspaces/linear-agents/linear-agent-bridge` root, preserving the 104
existing job-state records. If the physical workspace moves again, re-review
the expected path and its immutable runtime boundary; never weaken this
check to accept an arbitrary existing or empty directory.

## ABR-17 M5 — sealed Git verification by the bridge service UID

The production release under `/var/lib/bridge-runtime` is root-owned.
Managed submission checks its **actual clean release SHA** from the non-root
`bridge` account. Git's ownership exception must be restricted to that
release, and the root-owned `.git/index` must allow **read-only** access to
the service UID. A global `safe.directory=*` is prohibited.

After each reviewed sealed checkout deployment, run the operator-owned script
from the **sealed** installed release (not the writable workspace):

```sh
/usr/bin/bash /var/lib/bridge-runtime/scripts/linux/m5-sealed-git-access.sh --apply
/usr/bin/bash /var/lib/bridge-runtime/scripts/linux/m5-sealed-git-access.sh --check
```

The script refuses a non-root operator, mutable ancestors, symlinked Git
metadata, or a dirty release. It grants only `u:bridge:r--` on the index;
it does not change the service environment, enable managed submission, or
mint provider credentials. Recheck after Git deployments, which may replace
the index inode and its ACL.

`scripts/submission-host-readiness.py` now reads the running systemd
MainPID's sealed Node entrypoint and actual service PATH. It reports
`releaseReady=false` until the independent protected binding, native
isolation, provider canaries and recovery acceptance are established.
