# Canonical bridge server

`agent-bridge-runtime.mjs` owns the HTTP listener, `/jobs` authorization, server startup, agent runtime wiring and the job root anchored to the original loader location. `http-helpers.mjs` owns protocol utilities; `http-route-composition.mjs` owns non-job ingress order.

The stable systemd/LaunchAgent path `linear-agent-bridge/agent-bridge.mjs` is a thin import-only loader. The canonical runtime explicitly derives `PROJECT_DIR` from that loader's location so `linear-jobs/`, routing files and CLI agent scripts are not relocated. No duplicate server listener or state authority is permitted.

## Local-only MCP relay design exercise (ABR-94)

`mcp-relay/index.mjs` is a test-only, independently authored, authenticated **localhost listener**, paired with a read-only host WebSocket fixture. It is not imported by `agent-bridge-runtime.mjs`, registered under `/jobs`, exposed through Cloudflare, or installed by systemd. The [relay README](mcp-relay/README.md) and [source audit](../../docs/audits/mcp/README.md) establish strict tool restrictions and future ABR-95 OAuth/transport ownership. `jobs/persistence/job-store.mjs` stays the sole Linear task ledger.

## ABR-17 M4 — Managed submission selection

`BRIDGE_MANAGED_SUBMISSION_ENABLED=true` requires the protected Linux host binding at /etc/agent-bridge/managed-submission-host.mjs before starting the existing HTTP runtime. For AGY, Trae and chatgpt-cli, authenticated /jobs enters managed admission, not legacy dispatch; unapproved Mac routes are denied. No public submission endpoint. Default off preserves the legacy runtime. The host binding and operational enablement are M5 gates.

Legacy AGY quota retry recovery remains per-record, independent of managed submission enablement. Managed waiting-quota records never resume via the legacy timer; both startup and timer execution use the same predicate.

## ABR-17 M5 — Managed startup gate

The managed flag also requires successful strict non-root sandbox probe, clean release identity and root-owned host verifyActivation approval. Existing default-off operation remains unchanged. Offline recovery needs an inactive service, verified quiescence and a held exclusive lease.

## M13 memory source integration

`BRIDGE_VERIFIED_MEMORY_ENABLED=true` opts into the reviewed root-owned **non-credential** host-client binding. Missing/untrusted binding fails startup rather than falling back to an agent-writable source, while the unset/default-off flag preserves existing service behavior. Only the existing local task-preparation and authenticated issue-completion handlers consume the client; no root credentials or DB write access enter the bridge process. The host service, separate OS access boundary and M12 rollout are M14 gates. See [M13 contract](../../docs/ABR59_VERIFIED_MEMORY_LIFECYCLE.md).

## ABR-59 M14 — protected root-memory boundary

The proposed root-owned client is loaded only through the existing opt-in Bridge feature after separately approved deployment. A Linux AF_UNIX service authenticates the exact systemd Bridge process rather than trusting the shared coding-agent uid. Neither the existing HTTP server nor its agent children obtain root credentials, database write roles or a generic privileged command. Source merge alone never activates the service. See [M14](../../docs/ABR59_M14_ACTIVATION.md).

## ABR-59 M14 — immutable source / writable job-state split

The `BRIDGE_RUNTIME_PROJECT_DIR` environment variable is reserved for the
operator-owned systemd launcher. The Bridge imports reviewed JS from
the immutable `/var/lib/bridge-runtime` Git release, while job-state files,
agent workspaces, routing and CLIs continue using the previously
existing writable `/home/bridge/agent-bridge/linear-agent-bridge` runtime.
The override defaults to the source directory for existing development and
legacy production launches and rejects relative, traversing and malformed
paths. See [sealed deployment](../../docs/ABR59_M14_ACTIVATION.md).

The M5 managed-submission source approval continues to verify the separately
sealed Git checkout from SOURCE_PROJECT_DIR, **not** BRIDGE_RUNTIME_PROJECT_DIR.
Only job-state, agent workspaces and mutable routing use the runtime override.

For sealed launches, executable Antigravity `run_agent.py` and the GitHub
shortcut handoff script resolve from `SOURCE_PROJECT_DIR`, never from the
agent-writable runtime checkout. Any historical `RUN_AGENT_PATH` override is
ignored for the sealed runtime. Shortcut subprocesses receive a minimal
environment without Bridge OAuth, API or shared-secret variables. Existing
development launches preserve their previous path overrides.
