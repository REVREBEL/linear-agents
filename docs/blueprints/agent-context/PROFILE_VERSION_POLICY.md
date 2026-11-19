# Research profile version policy (ABR-65 / A6)

**Current decision:** The approved NotebookLM `AgentRegistryEntry` research profile schema does **not** define a `profileVersion` field. Research profiles are intentionally **unversioned per entry** until a separate reviewed schema migration is approved. Do not silently append a `profileVersion` property to catalog entries, individual candidates, schema mirrors, or promotion proposals.

## Distinct version fields

| Field | Owner | Meaning |
| --- | --- | --- |
| `version: 1.0.0` | Research catalog wrapper `agents/agent-registry.yaml` | Catalog metadata only; **not** an agent-entry schema or installed runtime version |
| `profileVersion` | **Undefined** in current `AgentRegistryEntry` | Reserved for a **future explicitly reviewed** profile schema revision |
| `schemaVersion: 2` | Executable `agents/registry.json` | Independent Bridge runtime identity/Worker/policy registry schema |
| `schemaVersion: 1` | Staged `/opt/agents/registry/agent-runtimes.json` | Host-only CLI harness inventory; not executable agent schema |
| `context.version: 1` | Proposed README context frontmatter | Independent documentation metadata contract |

The approved research schema is `templates/context/agent-profile.entry.schema.json`, with a byte-identical compatibility mirror at `agents/agent-registry-schema.json`. The original research schema is intentionally permissive about unspecified properties, so plain JSON Schema validation alone would **not reject** an unrecognized `profileVersion`.

## Enforcement in this revision

- `scripts/validate-context-blueprint.py` rejects `profileVersion` in the schema, example profile, all catalog entries (including historical snapshots), and all individual current candidate YAML profiles.
- `scripts/review-research-promotion.py` also refuses a `profileVersion` field or schema addition before compiling an inert executable Registry v2 proposal. Neither an unexpected field nor a research entry version may be promoted into executable authority.
- `scripts/test_context_profile_version.py` covers allowed unversioned profiles, rejection of an injected field, rejection of an unreviewed schema extension, rejection in the proposal compiler, and independence of the catalog wrapper version.
- GitHub Actions runs the profile-version test with the existing schema and research-promotion validation. These checks enforce the *current* contract; they are deliberately designed to fail if versioning is introduced without an explicit gate update.

## Required process before adopting profileVersion

1. **Separate schema-review milestone and PR.** State why per-entry versioning is needed, propose version format, default rules, compatibility horizon, acceptance criteria and rollback strategy; do not relabel the existing catalog filename as a schema version.
2. **Review the canonical schema and compatibility mirror together.** Add a documented, validated `profileVersion` definition only with an approved migration. Keep the existing attached source contract intact until approval.
3. **Design migration for all active research profiles.** Update `agents/agent-registry.yaml` and the matching files in `agents/profiles/candidates/` together; document how older profiles are handled. Historical 14- and 15-agent snapshots remain historical evidence and are not rewritten.
4. **Update validators, proposal compiler and tests intentionally in that same reviewed change.** Remove or amend the current explicit rejection only after positive and negative migration tests establish the accepted versions, invalid-value behavior, and backward compatibility.
5. **Keep execution independent.** Even a versioned research entry needs verified model/runtime/Worker evidence, separate policy review and explicit executable Registry v2 registration before it may affect dispatch.

See [Agent ownership](OWNERSHIP.md), [template contracts](../../../templates/context/README.md), [profile mapping](../../../templates/context/profile-mapping.md), and [ABR-65](https://linear.app/revrebel/issue/ABR-65/a6-keep-profileversion-changes-schema-reviewed).
