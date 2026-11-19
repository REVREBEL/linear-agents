"""B3: source-linked context metadata must retain existing owning README text."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "scripts/validate-context-blueprint.py"
SPEC = importlib.util.spec_from_file_location("context_validator_b3", SRC)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)
MANIFEST = yaml.safe_load((ROOT / ".agents/context.yaml").read_text())
SCHEMA = json.loads((ROOT / "templates/context/context-frontmatter.schema.json").read_text())


class OwningReadmeTests(unittest.TestCase):
    def test_active_frontmatter_contract(self):
        validator.validate_active_readme_metadata(MANIFEST, SCHEMA)

    def test_owning_readme_bodies_are_retained(self):
        agents = (ROOT / "agents/README.md").read_text().split("\n---\n", 1)[1]
        bridge = (ROOT / "bridge/README.md").read_text().split("\n---\n", 1)[1]
        self.assertIn("# Agent registry", agents)
        self.assertIn("## Independent profile contracts", agents)
        self.assertIn("## Ubuntu runtime boundary", agents)
        self.assertIn("# Canonical bridge architecture", bridge)
        self.assertIn("server/agent-bridge-runtime.mjs", bridge)

    def test_cross_root_dependencies_are_declared_optional(self):
        for doc_id in ("repo.agents", "repo.bridge"):
            path = ROOT / MANIFEST["documents"][doc_id]["path"]
            data = yaml.safe_load(path.read_text()[4:].split("\n---\n", 1)[0])
            self.assertIn("host.agent-runtimes", data["context"]["requires"])
            for dep in data["context"]["requires"]:
                self.assertIn(dep, MANIFEST["documents"])
        for root in ("host-agents", "host-agent-tools", "host-global-tools"):
            self.assertIs(MANIFEST["roots"][root]["required"], False)

    def test_rejects_missing_document_alias(self):
        changed = copy.deepcopy(MANIFEST)
        changed["documents"]["repo.bridge"]["path"] = "bridge/other.md"
        with self.assertRaisesRegex(ValueError, "alias does not match"):
            validator.validate_active_readme_metadata(changed, SCHEMA)

    def test_rejects_missing_host_dependency_alias(self):
        changed = copy.deepcopy(MANIFEST)
        del changed["documents"]["host.agent-tools"]
        with self.assertRaisesRegex(ValueError, "missing or self-referential dependency"):
            validator.validate_active_readme_metadata(changed, SCHEMA)

    def test_rejects_relabeling_optional_host_as_required(self):
        changed = copy.deepcopy(MANIFEST)
        changed["roots"]["host-agents"]["required"] = True
        with self.assertRaisesRegex(ValueError, "host root unexpectedly required"):
            validator.validate_active_readme_metadata(changed, SCHEMA)


if __name__ == "__main__":
    unittest.main()
