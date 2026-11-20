# ABR-97 — non-startable macOS host candidate

`desktopcommander-mcp-host.plist.example` is a placeholder only, with `Disabled=true`, `RunAtLoad=false`, and `ProgramArguments=/usr/bin/false`. It is not a deployable host agent and is intentionally separate from the existing `io.revrebel.agent-bridge` service. Never load it or replace its executable until the true Mac OS principal, project grants, transport key, sandbox and ABR-98/100 authentication tests have been approved.

See [ABR-97 actual SSH evidence](../../../docs/audits/mcp/MACOS_HOST.md).
