#!/usr/bin/env python3
"""Validate research and runtime examples without activating Agent Bridge."""
from pathlib import Path, PurePosixPath
import json
import re

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates/context"
BLUEPRINT = ROOT / "docs/blueprints/agent-context"


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_yaml(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def validate(instance, schema, label):
    errors = sorted(Draft202012Validator(schema).iter_errors(instance),
                    key=lambda error: tuple(str(part) for part in error.path))
    if errors:
        first = errors[0]
        location = "/".join(map(str, first.absolute_path)) or "<root>"
        raise ValueError(f"{label} at {location}: {first.message}")


def guard_research_schema_version(schema):
    """Require an explicit schema migration before defining per-entry profileVersion."""
    if "profileVersion" in schema.get("properties", {}):
        raise ValueError(
            "profileVersion is not part of the approved AgentRegistryEntry schema; "
            "introduce it only in a separately reviewed schema/migration change"
        )


def validate_research_profile(instance, schema, label):
    """Block a silent profileVersion field even though the source schema allows extras."""
    if isinstance(instance, dict) and "profileVersion" in instance:
        raise ValueError(
            f"{label}: undeclared profileVersion requires a reviewed "
            "research schema migration"
        )
    validate(instance, schema, label)


def validate_bootstrap_manifest(manifest, label):
    """Validate B1 manifest pointers; formal context schema belongs to C1."""
    if not isinstance(manifest, dict) or manifest.get("contextVersion") != 1:
        raise ValueError(f"{label}: contextVersion must equal 1")
    roots, documents, entrypoints = (
        manifest.get("roots"), manifest.get("documents"), manifest.get("entrypoints")
    )
    if not all(isinstance(item, dict) and item for item in (roots, documents, entrypoints)):
        raise ValueError(f"{label}: roots, documents and entrypoints are required mappings")
    repo = roots.get("repo")
    if repo != {"path": ".", "required": True}:
        raise ValueError(f"{label}: repo root must be the project-root relative '.'")
    for name, config in roots.items():
        if not isinstance(config, dict):
            raise ValueError(f"{label}: invalid root {name}")
        if name != "repo":
            env, default, required = (
                config.get("environment"), config.get("default"), config.get("required")
            )
            if (not isinstance(env, str) or
                re.fullmatch(r"[A-Z][A-Z0-9_]*", env) is None or
                not isinstance(default, str) or not Path(default).is_absolute() or
                not isinstance(required, bool)):
                raise ValueError(f"{label}: invalid optional host root {name}")
    for doc_id, locator in documents.items():
        if not isinstance(doc_id, str) or not re.fullmatch(r"[a-z][a-z0-9.-]+", doc_id):
            raise ValueError(f"{label}: invalid document ID {doc_id!r}")
        if not isinstance(locator, dict) or set(locator) != {"root", "path"}:
            raise ValueError(f"{label}: invalid locator for {doc_id}")
        root, raw_path = locator["root"], locator["path"]
        if root not in roots or not isinstance(raw_path, str):
            raise ValueError(f"{label}: unknown root or missing path for {doc_id}")
        path = PurePosixPath(raw_path)
        if (not raw_path or path.is_absolute() or ".." in path.parts or
            "\\" in raw_path or raw_path.startswith("./")):
            raise ValueError(f"{label}: unsafe relative document path for {doc_id}")
        if root == "repo":
            resolved = (ROOT / raw_path).resolve()
            if not resolved.is_relative_to(ROOT.resolve()) or not resolved.is_file():
                raise ValueError(f"{label}: missing/outside repository document: {doc_id}")
    for name, document_id in entrypoints.items():
        if document_id not in documents:
            raise ValueError(f"{label}: unresolved entrypoint {name}: {document_id}")


def validate_active_readme_metadata(manifest, schema):
    """B3: verify in-place owning READMEs and declared cross-root dependencies."""
    documents = manifest["documents"]
    for doc_id, relative in (
        ("repo.bootstrap", ".agents/README.md"),
        ("repo.agents", "agents/README.md"),
        ("repo.bridge", "bridge/README.md"),
    ):
        path = ROOT / relative
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            raise ValueError(f"{relative}: missing context frontmatter")
        meta = yaml.safe_load(text[4:].split("\n---\n", 1)[0])
        validate(meta, schema, relative)
        ctx = meta["context"]
        if ctx["id"] != doc_id:
            raise ValueError(f"{relative}: expected context.id {doc_id}")
        if documents.get(doc_id) != {"root": "repo", "path": relative}:
            raise ValueError(f"{relative}: context document alias does not match manifest")
        for dep in ctx["requires"]:
            if dep == doc_id or dep not in documents:
                raise ValueError(f"{relative}: missing or self-referential dependency {dep}")
            locator = documents[dep]
            # Host documentation lands in B4: missing optional host roots are valid,
            # but the manifest must explicitly declare them optional.
            if locator["root"] != "repo" and manifest["roots"][locator["root"]]["required"]:
                raise ValueError(f"{relative}: host root unexpectedly required: {dep}")
        if doc_id == "repo.agents" and not set((
            "host.agent-runtimes", "host.agent-tools", "host.global-tools",
        )).issubset(ctx["requires"]):
            raise ValueError(f"{relative}: required host profile dependencies missing")
        if doc_id == "repo.bridge" and not set((
            "repo.agents", "host.agent-runtimes", "host.agent-tools",
            "host.global-tools",
        )).issubset(ctx["requires"]):
            raise ValueError(f"{relative}: required dispatch dependencies missing")


def main():
    schema_path = TEMPLATES / "agent-profile.entry.schema.json"
    mirror_path = ROOT / "agents/agent-registry-schema.json"
    if schema_path.read_bytes() != mirror_path.read_bytes():
        raise ValueError(
            "Research schema drift: templates/context/agent-profile.entry.schema.json "
            "must exactly match the agents/agent-registry-schema.json compatibility mirror"
        )
    profile_schema = load_json(schema_path)
    Draft202012Validator.check_schema(profile_schema)
    guard_research_schema_version(profile_schema)

    # Read all JSON templates, not only the entry schema.
    for path in sorted(TEMPLATES.glob("*.json")):
        load_json(path)

    profile_example = load_yaml(TEMPLATES / "agent-profile.v2.template.yaml")
    validate_research_profile(profile_example, profile_schema, "research profile template")
    assert profile_example["execution"]["quotaPolicy"]["maxRetryAttempts"] == 0
    assert profile_example["execution"]["sessionContinuityFlag"].startswith("--session ")
    assert "--prompt" not in profile_example["runtime"]["commandTemplate"]

    total = 1
    for path in (
        TEMPLATES / "agent-registry.catalog.template.yaml",
        BLUEPRINT / "references/agent-registry-v2.yaml",
        BLUEPRINT / "references/agent-registry.yaml",
        ROOT / "agents/agent-registry.yaml",
    ):
        catalog = load_yaml(path)
        profiles = catalog["agents"]
        if catalog["totalAgents"] != len(profiles):
            raise ValueError(f"{path}: totalAgents does not equal agents length")
        identifiers = [item["id"] for item in profiles]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError(f"{path}: duplicate agent ids")
        for i, item in enumerate(profiles):
            validate_research_profile(item, profile_schema, f"{path.relative_to(ROOT)} agents[{i}]")
        total += len(profiles)

    # ABR-62: check historical snapshot integrity without freezing future Git
    # research catalog changes to the 2026-11-12 snapshot.
    current_catalog = load_yaml(ROOT / "agents/agent-registry.yaml")
    approved_catalog = load_yaml(BLUEPRINT / "references/agent-registry-v2.yaml")
    historical_catalog = load_yaml(BLUEPRINT / "references/agent-registry.yaml")

    approved_profiles = {item["id"]: item for item in approved_catalog["agents"]}
    historical_profiles = {item["id"]: item for item in historical_catalog["agents"]}
    if set(approved_profiles) - set(historical_profiles) != {"colab-notebook-agent"}:
        raise ValueError("Historical snapshots no longer reflect the Colab-only addition")
    if set(historical_profiles) - set(approved_profiles):
        raise ValueError("Approved historical snapshot removed an existing research profile")
    for name, item in historical_profiles.items():
        if approved_profiles[name] != item:
            raise ValueError(f"Historical profile was modified in the newer snapshot: {name}")

    # The current research catalog may advance under later reviewed commits;
    # it must remain a consistent source of truth for individual candidates.
    current_profiles = {item["id"]: item for item in current_catalog["agents"]}
    if len(current_profiles) != current_catalog["totalAgents"]:
        raise ValueError("Canonical research catalog has duplicate IDs or wrong totalAgents")

    # One individually editable candidate per approved catalog profile.
    candidate_paths = sorted((ROOT / "agents/profiles/candidates").glob("*.yaml"))
    candidate_names = {path.stem for path in candidate_paths}
    if candidate_names != set(current_profiles):
        raise ValueError(
            "Candidate YAML inventory differs from canonical research catalog: "
            f"missing={sorted(set(current_profiles) - candidate_names)}; "
            f"unexpected={sorted(candidate_names - set(current_profiles))}"
        )
    for path in candidate_paths:
        item = load_yaml(path)
        validate_research_profile(item, profile_schema, f"candidate {path.name}")
        if item != current_profiles[path.stem]:
            raise ValueError(f"Research candidate differs from catalog entry: {path.name}")

    # The executable Bridge registry has a different schema from research entries.
    runtime_schema = load_json(ROOT / "agents/registry.schema.json")
    runtime_entry_schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": runtime_schema["$defs"],
        "$ref": "#/$defs/agent",
    }
    runtime_example = load_json(TEMPLATES / "bridge-runtime-registry.v2-entry.template.json")
    validate(runtime_example, runtime_entry_schema, "Bridge runtime entry template")
    validate(load_json(ROOT / "agents/registry.json"), runtime_schema,
             "Live declarative Bridge Registry v2")

    # Neither profile format is a subtype of the other.
    if Draft202012Validator(runtime_entry_schema).is_valid(profile_example):
        raise ValueError("Research entry incorrectly satisfies executable registry schema")
    if Draft202012Validator(profile_schema).is_valid(runtime_example):
        raise ValueError("Executable registry entry incorrectly satisfies research schema")

    context_schema = load_json(TEMPLATES / "context-frontmatter.schema.json")
    Draft202012Validator.check_schema(context_schema)
    for path in (
        TEMPLATES / "README.template.md",
        TEMPLATES / "host-root.README.template.md",
        BLUEPRINT / "bootstrap/.agents/README.md",
        ROOT / ".agents/README.md",
        TEMPLATES / "host-roots/agents/README.md",
        TEMPLATES / "host-roots/agent-tools/README.md",
        TEMPLATES / "host-roots/global-tools/README.md",
        BLUEPRINT / "bootstrap/agents.README.context-starter.md",
        BLUEPRINT / "bootstrap/bridge.README.context-starter.md",
    ):
        body = path.read_text(encoding="utf-8")
        if not body.startswith("---\n") or "\n---\n" not in body[4:]:
            raise ValueError(f"{path}: missing YAML frontmatter")
        frontmatter = yaml.safe_load(body[4:].split("\n---\n", 1)[0])
        validate(frontmatter, context_schema, str(path.relative_to(ROOT)))

    # B1: validate both original blueprint example and installed project-local
    # metadata, without requiring optional host READMEs that arrive in B4.
    for manifest_path in (
        BLUEPRINT / "bootstrap/.agents/context.yaml",
        ROOT / ".agents/context.yaml",
    ):
        validate_bootstrap_manifest(load_yaml(manifest_path), str(manifest_path.relative_to(ROOT)))
    actual_readme = (ROOT / ".agents/README.md").read_text(encoding="utf-8")
    bootstrap_context = yaml.safe_load(actual_readme[4:].split("\n---\n", 1)[0])["context"]
    if bootstrap_context["id"] != "repo.bootstrap":
        raise ValueError("Root bootstrap README ID must remain repo.bootstrap")
    active_manifest = load_yaml(ROOT / ".agents/context.yaml")
    if active_manifest["documents"]["repo.bootstrap"] != {
        "root": "repo", "path": ".agents/README.md"
    }:
        raise ValueError("Bootstrap document alias must reference .agents/README.md")
    if any(dep not in active_manifest["documents"] for dep in bootstrap_context["requires"]):
        raise ValueError("Root bootstrap README has an undeclared document dependency")

    validate_active_readme_metadata(active_manifest, context_schema)
    # B4: reviewed host-root README sources must agree with the declared host
    # aliases, but host installation itself is optional until post-merge apply.
    from importlib import util
    host_script = ROOT / "scripts/reconcile-host-root-readmes.py"
    spec = util.spec_from_file_location("host_root_readme_validator", host_script)
    host_module = util.module_from_spec(spec)
    spec.loader.exec_module(host_module)
    host_module.reviewed_sources()

    # One canonical copy of the uploaded research entry schema.
    duplicate = BLUEPRINT / "references/agent-registry-schema.json"
    if duplicate.exists():
        raise ValueError(f"Duplicate research entry schema: {duplicate}")
    print(f"Validated {total} research profile examples, independent executable "
          "registry entry and live Registry v2, schema-mirror parity, "
          "cross-contract rejection, per-profile version gate, "
          "README frontmatter, JSON templates, and context manifest.")


if __name__ == "__main__":
    main()
