# Agent Context v1 — manifest, README metadata and cross-platform root contract

**Milestone:** ABR-72 / C1. These schemas define validated *documentation* metadata for the future context resolver; they do not install a CLI, grant permissions, or change runtime configuration.

## Canonical contracts

| Source | Scope | Version field |
| --- | --- | --- |
| `templates/context/context-manifest.schema.json` | `.agents/context.yaml` project, root aliases, document IDs and entrypoints | `contextVersion: 1` |
| `templates/context/context-frontmatter.schema.json` | YAML frontmatter of an owning README | `context.version: 1` |
| `scripts/context_contract.py` | Reusable schema + semantic validation and platform-root selection | Follows both v1 schemas |
| `scripts/validate-context-contract.py` | Read-only verification of the current Git checkout | No runtime activation |

These versions are unrelated to the executable Bridge registry's `schemaVersion: 2`, research catalog's `version: 1.0.0`, or the template publisher's `.managed-context.json` `schemaVersion: 1`.

## Root aliases and platform selection

`roots.repo` is required and fixed to `{path: ".", required: true}`; `.` refers to the Git project root containing `.agents/`. All `documents.*.path` values are **POSIX-style, root-relative paths even on Windows**; an absolute path, drive prefix, parent traversal, backslash, `./`, or ambiguous separators are invalid.

Non-repository roots use stable symbolic aliases, an `environment` variable **name**, a `required` boolean, and a `default` absolute path and/or an optional `platformDefaults` mapping. Supported platform keys are `linux`, `darwin` and `win32`; a value must be absolute **for that OS**. Root path selection follows this order:

1. If the named environment variable is **set**, use its value only (reject empty, relative, non-native or traversal paths; never fall back silently).
2. Otherwise use the matching `platformDefaults.<os>` if provided.
3. Otherwise use the root's `default`, provided it is absolute for that OS. If it is not, require an explicit override and report an error.

For example, the root `host-agents` may retain its reviewed Linux `default: /opt/agents` while a developer sets `AGENT_CONTEXT_AGENTS_ROOT` on another host. Alternatively, a project may add `platformDefaults.win32` as a **reviewed, machine-appropriate absolute Windows path**; quote Windows backslashes carefully in YAML. The canonical Agent Bridge manifest intentionally does not invent Windows or Mac installations. Optional roots may be absent on a machine; a missing directory does not authorize a new directory creation.

The C1 `select_host_root` helper **selects an absolute path string only**. It does not check availability or resolve contents. C2 provides a portable, validation-only CLI entrypoint and repository discovery; C3–C5 own recursive document retrieval, root availability checks, stronger filesystem safety, and source-linked output.

## Document aliases, frontmatter and dependencies

- Document IDs are stable dotted names (e.g. `repo.bridge`, `host.agent-tools`); each locator maps an ID to one declared `root` and a safe relative `path`.
- `entrypoints` point to declared document IDs; a `default` entrypoint is mandatory. These aliases are data, not CLI switches yet.
- Every source-backed README declares `context.id`, `version`, `title`, `topics`, `requires`, `applies_to`, and `update_on`. Duplicate YAML keys, unknown frontmatter keys, missing fields, unsafe `applies_to` globs, unknown dependencies, self-dependencies, and cycles are rejected.
- The full source-backed dependency graph covers project READMEs (including `jobs/README.md`) and the three reviewed host-root README **sources** under `templates/context/host-roots/`. This validation does not read or require private native CLI homes. Additional optional host-only documents without a Git source can remain uninstalled during schema validation; C4 will enforce their actual availability and path safety during resolution.
- README bodies are preserved as-is; only the YAML header is interpreted for context metadata. No README text is an instruction to bypass Bridge admission, to read credentials, or to execute research candidate commands.

## Verification

From the project root, run `python3 scripts/validate-context-contract.py` for the full v1 manifest and documentation graph. Run `python3 scripts/test_context_contract.py` for negative tests covering duplicate keys, omitted metadata, traversal, cycles, missing/escaping documents, and Linux/macOS/Windows overrides. The existing `scripts/validate-context-blueprint.py` and scoped GitHub Actions workflow also invoke this contract.

When the schema or reusable templates change, first merge the reviewed PR; then explicitly republish the Git sources on Ubuntu using `python3 scripts/publish-context-templates.py --apply` and verify `--check`. This keeps `/opt/agent-tools/templates/context/` versioned without running any agent, restarting services, or changing `/opt/agents/` native state.
