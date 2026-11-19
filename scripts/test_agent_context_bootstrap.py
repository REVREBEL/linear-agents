"""B1 smoke tests for a safe, source-controlled project context manifest."""
import copy
import importlib.util
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/validate-context-blueprint.py"
SPEC = importlib.util.spec_from_file_location("context_manifest_validation", SOURCE)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)
MANIFEST = yaml.safe_load((ROOT / ".agents/context.yaml").read_text(encoding="utf-8"))


class BootstrapManifestTests(unittest.TestCase):
    def test_project_bootstrap_with_optional_host_roots(self):
        validator.validate_bootstrap_manifest(MANIFEST, "installed")
        self.assertFalse(MANIFEST["roots"]["host-agents"]["required"])
        self.assertEqual(MANIFEST["entrypoints"]["default"], "repo.bootstrap")
        self.assertTrue((ROOT / ".agents/README.md").is_file())

    def test_rejects_repo_path_traversal(self):
        changed = copy.deepcopy(MANIFEST)
        changed["documents"]["repo.agents"]["path"] = "../other-project/README.md"
        with self.assertRaisesRegex(ValueError, "unsafe relative"):
            validator.validate_bootstrap_manifest(changed, "test")

    def test_rejects_unknown_root_alias(self):
        changed = copy.deepcopy(MANIFEST)
        changed["documents"]["repo.agents"]["root"] = "unknown"
        with self.assertRaisesRegex(ValueError, "unknown root"):
            validator.validate_bootstrap_manifest(changed, "test")

    def test_rejects_missing_required_repo_document(self):
        changed = copy.deepcopy(MANIFEST)
        changed["documents"]["repo.agents"]["path"] = "agents/not-a-real-readme.md"
        with self.assertRaisesRegex(ValueError, "missing/outside repository"):
            validator.validate_bootstrap_manifest(changed, "test")

    def test_rejects_unresolved_entrypoint(self):
        changed = copy.deepcopy(MANIFEST)
        changed["entrypoints"]["profiles"] = "repo.unknown"
        with self.assertRaisesRegex(ValueError, "unresolved entrypoint"):
            validator.validate_bootstrap_manifest(changed, "test")

    def test_rejects_bad_project_root(self):
        changed = copy.deepcopy(MANIFEST)
        changed["roots"]["repo"]["path"] = "/home/bridge/agent-bridge"
        with self.assertRaisesRegex(ValueError, "repo root must"):
            validator.validate_bootstrap_manifest(changed, "test")


if __name__ == "__main__":
    unittest.main()
