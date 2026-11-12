# Agent Registry v2 (ABR-28 P1)

The canonical machine-readable profile and execution contract lives in `agents/registry.json`, validated against `agents/registry.schema.json` (Draft 2020-12). The version is `schemaVersion: 2`.

## Contract boundaries

- `profile` is discovery metadata: human name, kind, selectable model, taxonomy, supported intents, and ratings with provenance. User-supplied ratings are *not* measured benchmarks.
- `runtimeContract` describes transport and target host, executable environment-variable reference, *argv tokens* (not a shell command), workspace environment variable, conversation continuation, optional quota metadata, and optional Linear/Cloudflare callbacks.
- `executionPolicy` describes intended autonomy, scoped memory, permissions, credential stripping, approved tool identifiers, and post-execution handoff destinations.
- `packageDir` is the existing physical package path, checked against the repository filesystem. `targetPackageDir` is the intended P3 destination and does not need to exist until that stage. This explicitly prevents the v2 layout plan from masquerading as a deployable location.
- The existing `worker`, `linear`, and `execution` fields remain for P1 backward compatibility. `worker.serviceTemplate` records the tracked template's static name; `worker.deployedName` records the intended live Worker deployment name. For ChatGPT CLI these differ today; do **not** rename deployments to make the template match.
- The same Linear OAuth application can be shared by different workers without conflating Cloudflare Worker name, KV namespace, or conversation role.

## Important trust boundaries

**Registry metadata does not grant permissions.** No runner may infer Git write, push, merge, deployment, MCP access, credential distribution, or shell access exclusively from this file. Enforcement belongs in the bridge dispatcher, host process permissions, policy checks, and existing authentication/authorization flows. Default policy for profiles lacking verified capability data is deny-by-default; this is intentional and not a description of today's effective privileges.

`runtimeContract.executable.argv` is a *declarative reference* to desired argument tokens. Never pass these through a shell or interpolate a prompt into a command string. P1 must resolve placeholders into an argument array with strict allowlisted tokens and use the existing provider launcher's tested interface. The Antigravity command and model reference came from the supplied profile and require verification against the installed CLI before dispatch. `executionHost` is a proposed host profile, not a production routing change. Existing Ubuntu and macOS dispatch configuration remains authoritative until P1/P5 explicitly migrate it.

`envStripPatterns` and `mcpToolAllowlist` are intentions requiring runtime enforcement and review. No new permission is enabled by this PR. Likewise `quotaPolicy` only describes desired retry behavior; the currently deployed retry handler remains authoritative.

## Validation

Run `npm run registry:validate` for the schema subset and the checked-in Wrangler identity contract. The dependency-free validator walks every v2 nested field (types, enums, required keys, disallowed extras, numeric bounds, patterns, and references), checks current package directory existence, Wrangler JSONC structure and KV/DO bindings, and duplicate IDs/Worker paths/bindings/deployed names and rejects unexpected deployed names. `npm run bridge:test` and `npm run test:reliability` include registry regression tests.

The schema is Draft 2020-12, but the local validator intentionally supports only keywords actually used here; adding schema keywords requires extending the validator or introducing a full standards-compliant JSON Schema validator. CI should also explicitly invoke `npm run registry:validate` in P1. The registry file does not alter the existing worker path lookups until P1 integrates it into scripts and lockfile/workspaces.

## Production compatibility

This P1 contract PR must not move Workers, rotate credentials, update tunnels or routes, deploy Cloudflare scripts, restart systemd/LaunchAgent, change live job state, or migrate the bridge data directory. Those are separately authorized stages under ABR-28. Preserve all historical job IDs, session IDs, GitHub app identities and complete job ledger state.
