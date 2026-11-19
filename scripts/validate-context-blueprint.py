#!/usr/bin/env python3
"""Validate research and runtime examples without activating Agent Bridge."""
from pathlib import Path
import json

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

    # Read all JSON templates, not only the entry schema.
    for path in sorted(TEMPLATES.glob("*.json")):
        load_json(path)

    profile_example = load_yaml(TEMPLATES / "agent-profile.v2.template.yaml")
    validate(profile_example, profile_schema, "research profile template")
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
            validate(item, profile_schema, f"{path.relative_to(ROOT)} agents[{i}]")
        total += len(profiles)

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
        BLUEPRINT / "bootstrap/agents.README.context-starter.md",
        BLUEPRINT / "bootstrap/bridge.README.context-starter.md",
    ):
        body = path.read_text(encoding="utf-8")
        if not body.startswith("---\n") or "\n---\n" not in body[4:]:
            raise ValueError(f"{path}: missing YAML frontmatter")
        frontmatter = yaml.safe_load(body[4:].split("\n---\n", 1)[0])
        validate(frontmatter, context_schema, str(path.relative_to(ROOT)))

    manifest = load_yaml(BLUEPRINT / "bootstrap/.agents/context.yaml")
    if manifest.get("contextVersion") != 1 or not manifest.get("roots"):
        raise ValueError("Context bootstrap manifest is missing its version or roots")

    # One canonical copy of the uploaded research entry schema.
    duplicate = BLUEPRINT / "references/agent-registry-schema.json"
    if duplicate.exists():
        raise ValueError(f"Duplicate research entry schema: {duplicate}")
    print(f"Validated {total} research profile examples, independent executable "
          "registry entry and live Registry v2, schema-mirror parity, "
          "cross-contract rejection, README frontmatter, JSON templates, "
          "and context manifest.")


if __name__ == "__main__":
    main()
