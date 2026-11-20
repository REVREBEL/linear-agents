# macOS Bridge scripts and host enrollment

The existing `bridge.sh`, `install-launchagent.sh` and `agent-bridge.plist.example` manage the current Mac Bridge service; ABR-97 does not alter or invoke them.

The separate [DesktopCommander host launchd candidate](launchd/desktopcommander-mcp-host.plist.example) is disabled and deliberately starts `/usr/bin/false`, so it cannot act as a functional host before operator approval, verified signed device pairing and an audited macOS sandbox. No launchd installation or restart occurs in this PR. See [ABR-97 Mac identity/runbook](../../docs/audits/mcp/MACOS_HOST.md).
