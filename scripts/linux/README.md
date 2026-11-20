# Ubuntu Bridge system setup and candidate units

Existing `install-systemd.sh`, `install-github-event-publisher.sh`, and `bridge.sh` manage the independently deployed canonical Bridge components. None of them install the ABR-96 source-only MCP executor.

The [ABR-96 candidate unit](systemd/desktopcommander-mcp-host-agent.service.example) is **deliberately non-startable**, with `User=bridge`, an opt-in approval marker condition, strict namespace readiness preflight, systemd cgroup teardown, and `ExecStart=/usr/bin/false` until the separately reviewed ABR-97 host agent exists. Do not copy to /etc/systemd/system or enable it; the real service-user namespace policy is currently blocked by AppArmor on this server.

See [ABR-96 executor and OS policy gate](../../docs/audits/mcp/EXECUTOR.md) and `scripts/mcp-executor-probe.mjs --strict` before any future approved deployment. Existing systemd installations and `agent-bridge.service` are out of scope.
