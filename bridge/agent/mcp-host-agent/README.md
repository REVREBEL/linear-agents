# Read-only paired host MCP fixture (ABR-94)

`index.mjs` exposes `connectLocalHostAgent({ endpoint, agentToken, deviceId, workspace })`. It establishes an **outbound WebSocket connection only to a local loopback `/agent` endpoint**, authenticated by a separate >=32-character secret and fixed device identity. Neither inbound internet access nor external relay registration is enabled.

The only tool handler is a bounded UTF-8 `read_file` scoped to an approved absolute workspace. It checks realpath and symlinks, refuses root directories and nonregular files, caps content at 256 KiB and implements bounded line pagination with full-source SHA-256. It does not spawn commands, fetch external URLs, upload source files, write content or call Linear/GitHub. Requests through `tools/call` are checked again by the relay.

**This is not an OS filesystem sandbox.** ABR-96 must add race-resistant, OS-principal-enforced authorization before production process/file handling. ABR-97 must validate host enrollment, macOS identity and revocation. Test with `node --test scripts/test-mcp-foundation.mjs` and review [ABR-94 decisions](../../../docs/audits/mcp/README.md).
