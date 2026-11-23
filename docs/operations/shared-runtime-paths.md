# Shared runtime and agent profile paths

The Ubuntu Bridge host keeps shared executable runtimes and agent profiles under `/opt`; home directories and the Agent Bridge checkout route to those canonical locations with symlinks.

| Purpose | Canonical path | Bridge home route | Checkout route |
|---|---|---|---|
| Volta runtime and Node toolchains | `/opt/global-tools/volta` | `/home/bridge/.volta` | `/home/bridge/agent-bridge/.volta` |
| Kilo profile and agent definitions | `/opt/agents/kilo/.kilo` | `/home/bridge/.kilo` | `/home/bridge/agent-bridge/.kilo` |

The Agent Bridge systemd service and Linux installer templates set `VOLTA_HOME=/opt/global-tools/volta` and prepend `/opt/global-tools/volta/bin` to `PATH`. Do not install or initialize Volta inside the repository checkout.

Kilo agent definitions belong in `/opt/agents/kilo/.kilo/agents`. Do not store a second profile copy in the checkout. The checkout-level `.kilo` and `.volta` entries are host symlinks and are intentionally excluded from Git.

The previous nested Volta directory was retained at `/opt/global-tools/archive/bridge-agent-bridge-volta-20261122`; the previous nested Kilo directory was retained at `/opt/agents/kilo/project-kilo-config-archive-20261122` for rollback reference.
