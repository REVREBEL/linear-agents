# NotebookLM research profile → Bridge executable Registry v2

The research schema is authoritative at [`agent-profile.entry.schema.json`](agent-profile.entry.schema.json), mirrored byte-for-byte at `agents/agent-registry-schema.json` for existing tooling. The executable Registry v2 has its own source schema at `agents/registry.schema.json`; neither is a subtype of the other. Examples and CI must validate both independently and reject cross-contract substitution.

This mapping is **conceptual and review-gated**. The two formats have independent schemas and must not be silently merged. `AgentRegistryEntry` from the attached `agent-registry-schema.json` is not the same as `#/$defs/agent` from the live `agents/registry.schema.json`.

| NotebookLM research field | Bridge `agents/registry.json` | Review/translation requirement |
| --- | --- | --- |
| `id` | `id` | Confirm unique slug and explicit agent identity. |
| `displayName`, `kind` | `profile.displayName`, `profile.kind` | `kind` enums differ: some candidate kinds cannot be represented without an approved mapping. |
| `description` | No dedicated equivalent | Retain research narrative/provenance; do not silently discard. |
| `provider`, `model` | `provider` and `profile.model` | Runtime provider is often a harness like `opencode`, not the model vendor. Verify model ID and inference provider. |
| `runtime.transport` | `runtimeContract.transport` | Enums differ (`direct_api` versus `api`, etc.); translate explicitly. |
| `runtime.executionHost` | `runtimeContract.executionHost` | Requires mapping to an authorized host; not a textual path rewrite. |
| `runtime.binaryPath`, `runtime.commandTemplate` | `runtimeContract.executable.binaryEnv`, `.argv` | Verify installed CLI and argv tokens; never execute a research shell template as-is. |
| `runtime.workspaceRoot` | `runtimeContract.workspaceRootEnv` + workspace resolver | Use validated workspace authorization rather than research path interpolation. |
| `linearBridge` | `runtimeContract.linearBridge` plus `worker` and `linear` | Resolve actual deployed identities and OAuth app, Worker, KV and Tunnel mappings; event vocabularies differ. |
| `taxonomy`, `routing` | `profile.taxonomy`, `profile.routing` | Verify intents. `task_ratings` plain numbers become rated records with evidence provenance. |
| `execution.autonomy_level` | `executionPolicy.autonomy_level` | Enums differ (`Read-only`, `Recommender`, `Supervised`, `Executor`, `Autonomous` versus `Observer`, `Advisor`, `Executor`). Requires reviewed mapping. |
| `execution.memory_scope` | `executionPolicy.memory_scope` | Enums differ (`stateless`, `session_isolated`, `project_persistent` vs `session_isolated`, `task`, `persistent`). No automatic identity mapping for all values. |
| `execution.sessionContinuityFlag`, `quotaPolicy` | `runtimeContract` fields | Verify actual installed CLI semantics and retry policies. |
| `permissions` | `executionPolicy.permissions` | These are metadata: enforce independently at admission, runner, and host layers. |
| `security` | `executionPolicy.security` | Validate enum and tool identifiers and strip real secrets in child environments. |
| No equivalents in candidate profile | `role`, `packageDir`, `worker`, `execution`, `linear`, `targetPackageDir` | Must be supplied from reviewed, real Bridge installation details. |

## Version names

- `agent-registry-v2.yaml` is a filename. Its root says `version: 1.0.0`; the attached per-agent JSON Schema has no formal `schemaVersion` field.
- The executable `agents/registry.json` explicitly uses `schemaVersion: 2` and a different field layout.
- The README context frontmatter separately has `context.version: 1`.

Never use the same number to imply these three formats are equivalent. Future profile-schema versioning should be introduced through an explicit schema revision and migration, not by adding undocumented fields.