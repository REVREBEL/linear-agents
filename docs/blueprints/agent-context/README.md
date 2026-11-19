# Agent Context System — corrected blueprint (uploaded research profile schema)

This is a portable source-based context system proposal. It contains templates, source references, bootstrap examples and implementation tasks; **it does not deploy an executable or change the running bridge**.

## Implemented ownership contract

[Git and /opt source-of-truth boundaries](OWNERSHIP.md) (ABR-60) specify which directories own source-controlled definitions, host runtime state, shared agent tools and general tooling. This is documentation-only; host bootstrap, resolver and runtime activation remain separate implementation tasks.

## Corrected profile contract

The uploaded `agent-registry-schema.json` defines **one research profile entry**, with top-level `id`, `displayName`, `description`, `kind`, `provider`, `model`, `runtime`, `linearBridge`, `taxonomy`, `routing`, `execution`, `permissions`, and `security`. The uploaded `agent-registry-v2.yaml` is a catalog of 15 profiles; `agent-registry.yaml` is an older catalog of 14. The added ID in the first catalog is `colab-notebook-agent`. Both catalogs declare `version: 1.0.0` and both satisfy the uploaded entry schema.

The current Bridge `agents/registry.json` with `schemaVersion: 2` is **another, independent executable registry format**, with fields such as `profile`, `runtimeContract`, and `executionPolicy`. Its schema is `agents/registry.schema.json` in the Git repository. Its compatibility contract remains separate. Do not replace it with an uploaded research YAML file or use a thin `$ref` to it as a substitute for the user's profile schema.

## Package contents

- `templates/context/agent-profile.v2.template.yaml`: **corrected** complete candidate profile template conforming to the uploaded per-entry schema.
- `templates/context/agent-profile.entry.schema.json`: **canonical, editable research-entry schema**, validated byte-for-byte against the pre-existing compatibility mirror at `agents/agent-registry-schema.json`; only the template copy is maintained as schema source.
- `templates/context/agent-registry.catalog.template.yaml`: example catalog wrapper; the attached schema validates *entries*, not the wrapper.
- `templates/context/bridge-runtime-registry.v2-entry.template.json`: separate *Bridge-specific* runtime registry example, originally misidentified as the NotebookLM profile template.
- `templates/context/profile-mapping.md`: review-gated mapping between research profiles and executable Agent Registry v2.
- `templates/context/README.template.md` and `context-frontmatter.schema.json`: README metadata and documentation structure.
- `templates/context/host-root.README.template.md`: root README for `/opt/agents`, `/opt/agent-tools`, `/opt/global-tools`.
- `.agents/README.md`, `.agents/context.yaml`, `.agents/skills/agent-context/SKILL.md`, `AGENTS.bootstrap.md`: project bootstrap and shared CLI skill contract.
- `agents.README.context-starter.md`, `bridge/README.context-starter.md`: fragments to **merge** with existing READMEs, not replacements.
- `IMPLEMENTATION_TASKS.md`: milestones and tests (PostgreSQL UI excluded).
- `references/`: exact attached 14- and 15-agent research catalog snapshots for historical comparison. The shared entry schema is referenced from `templates/context/agent-profile.entry.schema.json` to prevent divergent copies.

## Template defaults and historical CLI examples

The profile template deliberately uses `maxRetryAttempts: 0` (no automatic retries until a provider retry policy is tested). It uses the installed OpenCode CLI's `--session` continuation flag; historical research catalogs mention `--session-id`, which is not the installed OpenCode v1.19.5 syntax. Keep research snapshots unchanged as evidence rather than treating their command strings as executable.

## Ownership and use

Git project `templates/context/` is the reusable source. A setup tool can install reviewed copies at `/opt/agent-tools/templates/context/`, while project-specific files live in `.agents/`. Runtime private settings remain under `/opt/agents/` and shared general tools under `/opt/global-tools/`.

Do not invoke the proposed `agent-context` command until the resolver is implemented. The `context.yaml` format and metadata are a proposed contract, not already supported CLI options.