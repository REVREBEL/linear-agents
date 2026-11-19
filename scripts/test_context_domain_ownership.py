"""B5 ownership metadata checks for memory and integration source folders."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "context_domain_ownership", ROOT / "scripts/validate-context-blueprint.py"
)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)
MANIFEST = yaml.safe_load((ROOT / ".agents/context.yaml").read_text(encoding="utf-8"))
SCHEMA = json.loads(
    (ROOT / "templates/context/context-frontmatter.schema.json").read_text(encoding="utf-8")
)


class DomainReadmeTests(unittest.TestCase):
    def test_all_six_domain_sources_validate(self):
        graph = validator.validate_domain_readme_metadata(MANIFEST, SCHEMA)
        self.assertEqual(set(graph), set(validator.DOMAIN_READMES))

    def test_original_source_modules_remain_in_place(self):
        for name in (
            "memory/active-task-memory.mjs",
            "memory/memu-memory.mjs",
            "memory/postgres-checkpoint-store.mjs",
            "memory/migrations/001_agent_checkpoints.sql",
            "memory/scripts/verify-postgres-checkpoints.sh",
            "integrations/github-events.mjs",
            "integrations/linear-credentials.mjs",
            "integrations/review-linear-notifier.mjs",
            "integrations/litellm/agent-runtime.mjs",
            "integrations/openrouter/agent-runtime.mjs",
        ):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_rejects_wrong_context_document_alias(self):
        changed = copy.deepcopy(MANIFEST)
        changed["documents"]["repo.memory"]["path"] = "memory/other.md"
        with self.assertRaisesRegex(ValueError, "invalid or missing context manifest alias"):
            validator.validate_domain_readme_metadata(changed, SCHEMA)

    def test_rejects_missing_context_document_id(self):
        changed = copy.deepcopy(MANIFEST)
        del changed["documents"]["repo.integrations"]
        with self.assertRaisesRegex(ValueError, "invalid or missing context manifest alias"):
            validator.validate_domain_readme_metadata(changed, SCHEMA)

    def test_rejects_unknown_dependency(self):
        with self.assertRaisesRegex(ValueError, "Unknown context documentation dependency"):
            validator.validate_domain_dependency_graph(
                {"repo.memory": ["repo.undefined"]}, {"repo.memory"}
            )

    def test_rejects_cross_directory_dependency_cycle(self):
        graph = {
            "repo.memory": ["repo.memory.migrations"],
            "repo.memory.migrations": ["repo.memory"],
        }
        with self.assertRaisesRegex(ValueError, "dependency cycle"):
            validator.validate_domain_dependency_graph(graph, set(graph))

    def test_rejects_cycle_through_existing_bridge_readme(self):
        bridge = ROOT / "bridge/README.md"
        original = Path.read_text
        def read_text(path, *args, **kwargs):
            text = original(path, *args, **kwargs)
            if path == bridge:
                text = text.replace("requires: [repo.agents,", "requires: [repo.memory, repo.agents,", 1)
            return text
        with mock.patch.object(Path, "read_text", read_text):
            with self.assertRaisesRegex(ValueError, "dependency cycle"):
                validator.validate_domain_readme_metadata(MANIFEST, SCHEMA)

    def test_manifest_entrypoints_reference_domain_roots(self):
        self.assertEqual(MANIFEST["entrypoints"]["memory"], "repo.memory")
        self.assertEqual(MANIFEST["entrypoints"]["integrations"], "repo.integrations")

    def test_frontmatter_is_unique_and_matches_ids(self):
        ids = []
        for doc_id, path in validator.DOMAIN_READMES.items():
            body = (ROOT / path).read_text(encoding="utf-8")
            front = yaml.safe_load(body[4:].split("\n---\n", 1)[0])
            ids.append(front["context"]["id"])
            self.assertEqual(front["context"]["id"], doc_id)
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
