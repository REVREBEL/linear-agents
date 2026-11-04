# Linear App OAuth credential synchronization

When the bridge receives a routed job, it calls the assigned agent's existing
Cloudflare Worker at `POST /bridge/access-token`, authenticating with the
existing `BRIDGE_SHARED_SECRET` and the job's Linear organization ID. The Worker
uses `getInstallation` and `LINEAR_DATA` KV, refreshing expiring OAuth tokens
as needed. Only the app access token is returned; not the refresh token.

The bridge atomically writes the current token into the repository root's
`.env.linear-bridge` as `ANTIGRAVITY_LINEAR_API_KEY`,
`TRAE_LINEAR_API_KEY`, `GEMINI_LINEAR_API_KEY`,
`CHATGPT_LINEAR_API_KEY`, or `MOCK_LINEAR_API_KEY`.
It adds `/.env.linear-bridge` to local Git info/exclude, refuses to write
when Git is already tracking the file, and sets permissions to 0600.

The agent's Linear MCP client **must be configured to use the agent-specific
environment variable**. The bridge injects it into spawned Antigravity, Trae,
and Gemini subprocess environments; Gemini Warp reads the file directly.
Desktop MCP clients may use their own configuration or existing OAuth login,
which must be changed separately. Merely writing the file will not change a
running MCP server's authorization. Restart/reconnect the MCP connection after
rotation, and remove personal `LINEAR_API_KEY` write connections.

Optional Worker origin pins (recommended):
`LINEAR_ANTIGRAVITY_WORKER_URL`, `LINEAR_TRAE_WORKER_URL`,
`LINEAR_GEMINI_WORKER_URL`, `LINEAR_CHATGPT_WORKER_URL`,
`LINEAR_MOCK_WORKER_URL`.

Deploy all Workers before the bridge to avoid rejected token requests.
No tokens or refresh tokens should be included in task payloads or logs.
