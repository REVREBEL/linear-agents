"""ABR-72: schema, YAML integrity, root override and document metadata tests."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import yaml
from jsonschema import Draft202012Validator

from context_contract import (
    HOST_SOURCE_DOCS, load_unique_yaml, select_host_root,
    validate_context_contract, validate_relative_document_path,
    validate_applies_to_pattern,
)

SOURCE = Path(__file__).resolve().parents[1]
BASE_MANIFEST = yaml.safe_load((SOURCE / ".agents/context.yaml").read_text(encoding="utf-8"))


class ContextContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        files = {
            ".agents/context.yaml",
            "templates/context/context-manifest.schema.json",
            "templates/context/context-frontmatter.schema.json",
            *HOST_SOURCE_DOCS.values(),
        }
        for locator in BASE_MANIFEST["documents"].values():
            if locator["root"] == "repo":
                files.add(locator["path"])
        for name in files:
            source = SOURCE / name
            destination = self.repo / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

    def validate(self, manifest=None):
        return validate_context_contract(self.repo, manifest)

    def test_canonical_contract_and_all_readmes(self):
        result = self.validate()
        self.assertEqual(result["manifest"]["contextVersion"], 1)
        self.assertEqual(len(result["validatedDocumentIds"]), 13)
        self.assertIn("repo.jobs", result["validatedDocumentIds"])
        self.assertIn("host.agent-runtimes", result["validatedDocumentIds"])

    def test_schema_is_draft_2020_12_and_strict(self):
        schema = json.loads(
            (self.repo / "templates/context/context-manifest.schema.json").read_text()
        )
        Draft202012Validator.check_schema(schema)
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(schema["properties"]["contextVersion"], {"const": 1})

    def test_document_ids_are_unique_in_yaml(self):
        target = self.repo / ".agents/context.yaml"
        content = target.read_text()
        line = next(row for row in content.splitlines(keepends=True) if row.startswith("  repo.jobs: "))
        target.write_text(content.replace(line, line + line, 1))
        with self.assertRaisesRegex(ValueError, "Duplicate context YAML key: repo.jobs"):
            self.validate()

    def test_duplicate_frontmatter_fields_are_rejected(self):
        target = self.repo / "jobs/README.md"
        text = target.read_text()
        target.write_text(text.replace("  version: 1\n", "  version: 1\n  version: 1\n", 1))
        with self.assertRaisesRegex(ValueError, "Duplicate context YAML key: version"):
            self.validate()

    def test_missing_required_schema_fields_fail(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        del changed["entrypoints"]
        with self.assertRaisesRegex(ValueError, "entrypoints"):
            self.validate(changed)

    def test_unknown_manifest_property_fails(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["documentRoot"] = "/tmp"
        with self.assertRaisesRegex(ValueError, "Additional properties"):
            self.validate(changed)

    def test_invalid_context_version_fails(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["contextVersion"] = 2
        with self.assertRaisesRegex(ValueError, "1 was expected"):
            self.validate(changed)

    def test_unknown_entrypoint_document_fails(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["entrypoints"]["runtime"] = "host.unknown"
        with self.assertRaisesRegex(ValueError, "Unknown context entrypoint"):
            self.validate(changed)

    def test_unknown_root_alias_fails(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["documents"]["repo.jobs"]["root"] = "fake-root"
        with self.assertRaisesRegex(ValueError, "Unknown context document root"):
            self.validate(changed)

    def test_document_traversal_and_windows_absolute_paths_fail(self):
        for path in ("../outside.md", "jobs/../README.md", "/etc/passwd",
                     "C:\\Windows\\README.md", "jobs//README.md", "jobs/./README.md"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Unsafe relative"):
                validate_relative_document_path(path)

    def test_unexpected_locator_field_fails(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["documents"]["repo.jobs"]["mode"] = "execute"
        with self.assertRaisesRegex(ValueError, "Additional properties"):
            self.validate(changed)

    def test_git_backed_host_alias_cannot_point_elsewhere(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["documents"]["host.agent-tools"]["path"] = "other.md"
        with self.assertRaisesRegex(ValueError, "Host source-backed context alias mismatch"):
            self.validate(changed)
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["documents"]["host.agent-tools"]["root"] = "host-agents"
        with self.assertRaisesRegex(ValueError, "Host source-backed context alias mismatch"):
            self.validate(changed)

    def test_valid_platform_specific_roots_are_schema_valid(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["roots"]["host-agents"]["platformDefaults"] = {
            "darwin": "/Users/example/agents",
            "win32": "C:\\agent-tools\\agents",
        }
        self.assertEqual(len(self.validate(changed)["validatedDocumentIds"]), 13)

    def test_missing_required_repo_readme_fails(self):
        (self.repo / "jobs/README.md").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or escaping repository"):
            self.validate()

    def test_symlink_escaping_repo_fails(self):
        doc = self.repo / "jobs/README.md"
        doc.unlink()
        external = Path(self.tmp.name) / "secret.md"
        external.write_text("not a repository document")
        doc.symlink_to(external)
        with self.assertRaisesRegex(ValueError, "Missing or escaping repository"):
            self.validate()

    def test_frontmatter_id_must_match_declared_alias(self):
        doc = self.repo / "jobs/README.md"
        doc.write_text(doc.read_text().replace("id: repo.jobs", "id: repo.other", 1))
        with self.assertRaisesRegex(ValueError, "Context README ID mismatch"):
            self.validate()

    def test_undeclared_dependency_fails(self):
        doc = self.repo / "jobs/README.md"
        doc.write_text(doc.read_text().replace("requires: [repo.bridge]", "requires: [repo.absent]", 1))
        with self.assertRaisesRegex(ValueError, "Unrecognized context dependency"):
            self.validate()

    def test_cross_domain_dependency_cycle_fails(self):
        doc = self.repo / "agents/README.md"
        doc.write_text(doc.read_text().replace(
            "requires: [host.agent-runtimes,", "requires: [repo.bridge, host.agent-runtimes,", 1
        ))
        with self.assertRaisesRegex(ValueError, "Context dependency cycle"):
            self.validate()

    def test_frontmatter_schema_requires_update_on(self):
        doc = self.repo / "jobs/README.md"
        doc.write_text(doc.read_text().replace(
            "  update_on: [behavior, contracts, configuration, dependencies, security, deployment]\n", "", 1
        ))
        with self.assertRaisesRegex(ValueError, "update_on"):
            self.validate()

    def test_reject_unsafe_applies_to_glob(self):
        with self.assertRaisesRegex(ValueError, "Unsafe context applies_to glob"):
            validate_applies_to_pattern("../outside/**")
        doc = self.repo / "jobs/README.md"
        doc.write_text(doc.read_text().replace('"jobs/**"', '"../outside/**"', 1))
        with self.assertRaisesRegex(ValueError, "Unsafe context applies_to glob"):
            self.validate()

    def test_strict_frontmatter_rejects_extra_keys(self):
        doc = self.repo / "jobs/README.md"
        doc.write_text(doc.read_text().replace(
            "context:\n", "extra_runtime_permission: true\ncontext:\n", 1
        ))
        with self.assertRaisesRegex(ValueError, "Additional properties"):
            self.validate()

    def test_cross_platform_root_selection(self):
        config = {
            "environment": "AGENT_CONTEXT_AGENTS_ROOT",
            "default": "/opt/agents",
            "platformDefaults": {
                "darwin": "/Users/example/agents",
                "win32": "C:\\agent-tools\\agents",
            },
        }
        self.assertEqual(select_host_root(config, "linux", {}), "/opt/agents")
        self.assertEqual(select_host_root(config, "darwin", {}), "/Users/example/agents")
        self.assertEqual(select_host_root(config, "win32", {}), "C:\\agent-tools\\agents")
        self.assertEqual(select_host_root(config, "win32", {
            "AGENT_CONTEXT_AGENTS_ROOT": "D:\\custom\\agents",
        }), "D:\\custom\\agents")
        with self.assertRaisesRegex(ValueError, "Invalid absolute win32"):
            select_host_root({"environment": config["environment"], "default": "/opt/agents"},
                             "win32", {})

    def test_invalid_cross_platform_root_overrides_fail(self):
        changed = copy.deepcopy(BASE_MANIFEST)
        changed["roots"]["host-agents"]["platformDefaults"] = {
            "win32": "/opt/agents",
        }
        with self.assertRaisesRegex(ValueError, "invalid win32 override"):
            self.validate(changed)
        changed["roots"]["host-agents"]["platformDefaults"] = {
            "unknown-os": "/opt/agents",
        }
        with self.assertRaisesRegex(ValueError, "Additional properties"):
            self.validate(changed)

    def test_environment_override_cannot_be_relative(self):
        root = {"environment": "AGENT_ROOT", "default": "/opt/agents"}
        for val in ("relative/agents", "", "../agents", "C:relative"):
            with self.subTest(value=val), self.assertRaisesRegex(ValueError, "Invalid absolute"):
                select_host_root(root, "linux", {"AGENT_ROOT": val})

    def test_optional_host_dirs_not_required_to_validate(self):
        self.assertFalse((self.repo / "opt").exists())
        self.assertEqual(len(self.validate()["validatedDocumentIds"]), 13)


if __name__ == "__main__":
    unittest.main()
