# ABR-64 — Review-gated research-profile promotion

The **research** `AgentRegistryEntry` YAML and the **executable** Bridge Registry v2 are independent contracts. This implementation compiles a **proposal**, not a live registration, from one canonical research candidate and a separate reviewed Bridge mapping.

## Inputs and authority

| Source | Required contents | Authority |
| --- | --- | --- |
| `agents/profiles/candidates/<id>.yaml` | One entry identical to the active `agents/agent-registry.yaml` research catalog; validates against `templates/context/agent-profile.entry.schema.json` | Research claims; **never** grants permission or identity |
| Reviewed mapping JSON | `schemaVersion: 1`, `candidateId`, `researchSha256`, independent `approval`, evidence references for model/runtime/Worker, and explicit Bridge-only fields | Records a review decision; the actual independent approval and supporting facts must be verified in the referenced GitHub PR |
| `agents/registry.schema.json` | Executable Registry v2 entry schema | Validates the resulting declarative entry |
| Existing Worker package | Reviewed package directory, `wrangler.jsonc`, service name, route, KV binding, Durable Object, and exact config SHA256 | Proves **source configuration exists and matches the reviewed digest**; not proof that a Worker was deployed |
| `agents/registry.json` | Current, canonical declarative Bridge registry | Used **read-only** for duplicate-ID, Worker name, and Worker-directory checks |

The template at [`templates/context/research-promotion.review.template.json`](../../../templates/context/research-promotion.review.template.json) deliberately has `REPLACE` placeholders. A valid review record must be completed **after** independent provider/CLI/Worker verification and approval in an actual PR. The tool checks that approval/evidence fields and URLs are present, but **does not contact GitHub or Cloudflare to authenticate the reviewer, approve a PR, or confirm a deployed endpoint**. External approval and deployment checks remain human-/CI-reviewed milestones.

## Mapping rules

- **Allowed initial research kinds:** `cli_agent` + `headless_cli` → Bridge `cli_agent` + `headless_cli`; `llm` + `direct_api` → Bridge `service_agent` + `api`. Other combinations require a separate reviewed adapter expansion.
- **Host:** Research `ubuntu_agent_server` → Bridge `bridge_service`. Other hosts require separate authorization and validation.
- **Profile:** ID, display name, model ID/vendor, taxonomy and routing intents are derived from the validated research entry. Research `description` and the SHA256 source fingerprint stay in the proposal's provenance. Research `task_ratings` are omitted until separately attributed and reviewed; they are not silently promoted as measured scores.
- **Executable / CLI:** `binaryEnv` and argv tokens come **only** from the reviewed Bridge mapping; no research `commandTemplate` is executed or copied. Shell operators, unvalidated placeholders, unsafe token structures, quota retries, and session continuation shortcuts are rejected. A manually recorded runtime verification evidence URL is required.
- **Worker:** Bridge identity, Worker directory, Wrangler service name, template route, KV binding, Durable Object and actual `wrangler.jsonc` SHA256 must match. Worker host, tunnel host, events and completion mode must agree across the reviewed mapping, research entry and verification record. Placeholder hosts are rejected.
- **Policy:** Reviewed autonomy cannot exceed research level; only `session_isolated` memory is currently supported. Every permission must be explicit and a subset of research permissions. `gitPush`, `autoMerge`, and `deployment` are always denied. Risk classification cannot be reduced, all source environment-strip rules must be retained, and tool/handoff lists cannot grow beyond research declarations. Credential escalation requires another reviewed workflow.
- **Schema & uniqueness:** Validate complete output against `agents/registry.schema.json#/$defs/agent`; reject existing agent IDs, Worker deployed names and Worker directories.

Note: This adapter does not infer real authorization from a candidate profile. Any eventual registry change must still pass `npm run registry:validate`, worker/CI review, admission and execution-policy enforcement, and explicit deployment procedures.

## Using the compiler

From the checked-out `linear-agents` repository, supply a verified review JSON file via:

`python3 scripts/review-research-promotion.py --candidate YOUR_ID --review PATH_TO_REVIEWED_MAPPING.json`

On success, stdout contains a JSON object with `status: reviewed-proposal-not-installed`, `provenance` and a schema-conforming `registryEntry`. The command writes no file. Reviewers may examine or manually extract the entry in a *separate* approved registry PR. **It never appends to `agents/registry.json`, invokes the CLI, provisions a Worker, creates OAuth credentials or enables dispatch.**

Use `python3 scripts/test_review_research_promotion.py` to run isolated positive and negative fixtures. These fixtures use synthetic evidence URLs and never represent actual approval or deployment.

## Boundaries

This milestone establishes the safe offline review/mapping interface, not automatic launchability. The 15 researched candidates remain unverified by default and must individually gain a real Worker package, endpoint, verified model/runtime evidence and independent approval before a proposal is accepted.

Related: [profile field mapping](../../../templates/context/profile-mapping.md), [research inventory](RESEARCH_CATALOG_INVENTORY.md), [ownership](OWNERSHIP.md), [ABR-64](https://linear.app/revrebel/issue/ABR-64/a5-create-reviewed-research-to-runtime-promotion-adapter).
