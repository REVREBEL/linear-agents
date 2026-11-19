"""ABR-75 C4: missing roots, unsafe symlinks, strict/partial retrieval."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import context_resolver as resolver
from context_contract import (
    ContextSourceUnavailable, reject_symlink_components,
    require_context_source,
)

ROOT = Path(__file__).resolve().parents[1]
HOSTS = {
    "agents": ("AGENT_CONTEXT_AGENTS_ROOT", "host.agent-runtimes"),
    "agent-tools": ("AGENT_CONTEXT_AGENT_TOOLS_ROOT", "host.agent-tools"),
    "global-tools": ("AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "host.global-tools"),
}


class ContextSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.environ = {}
        self.host_roots = {}
        for name, (environment, _) in HOSTS.items():
            directory = self.base / name
            directory.mkdir()
            shutil.copy2(
                ROOT / "templates/context/host-roots" / name / "README.md",
                directory / "README.md",
            )
            self.environ[environment] = str(directory)
            self.host_roots[name] = directory

    def resolve(self, **kwargs):
        return resolver.resolve_context(ROOT, environ=self.environ, **kwargs)

    def test_strict_missing_optional_host_root_is_an_error(self):
        shutil.rmtree(self.host_roots["agents"])
        with self.assertRaisesRegex(ContextSourceUnavailable, "host.agent-runtimes"):
            self.resolve(topic="profiles")

    def test_opt_in_partial_includes_missing_id_path_and_reasons(self):
        shutil.rmtree(self.host_roots["agents"])
        bundle = self.resolve(topic="profiles", allow_partial=True)
        self.assertTrue(bundle["partial"])
        self.assertEqual(len(bundle["missingDocuments"]), 1)
        missed = bundle["missingDocuments"][0]
        self.assertEqual(missed["id"], "host.agent-runtimes")
        self.assertEqual(missed["root"], "host-agents")
        self.assertEqual(missed["sourcePath"], str(self.host_roots["agents"] / "README.md"))
        self.assertIn("required by: repo.agents", missed["reasons"])
        self.assertIn("Context source missing", missed["error"])
        self.assertTrue(all("content" in doc for doc in bundle["documents"]))
        self.assertIn("repo.agents", [doc["id"] for doc in bundle["documents"]])
        self.assertIn("host.agent-tools", [doc["id"] for doc in bundle["documents"]])
        self.assertIn("Missing optional context documents",
                      resolver.render_context(bundle))
        as_json = json.loads(resolver.render_context(bundle, output_format="json"))
        self.assertEqual(as_json, bundle)

    def test_strict_missing_optional_readme_file_and_partial(self):
        (self.host_roots["global-tools"] / "README.md").unlink()
        with self.assertRaisesRegex(ContextSourceUnavailable, "host.global-tools"):
            self.resolve(topic="profiles")
        bundle = self.resolve(topic="profiles", allow_partial=True)
        self.assertEqual(bundle["missingDocuments"][0]["id"], "host.global-tools")
        self.assertTrue(bundle["partial"])

    def test_all_available_does_not_mark_partial(self):
        bundle = self.resolve(topic="profiles", allow_partial=True)
        self.assertFalse(bundle["partial"])
        self.assertEqual(bundle["missingDocuments"], [])
        for doc in bundle["documents"]:
            self.assertEqual(doc["content"], Path(doc["sourcePath"]).read_text())

    def test_partial_explain_omits_only_bodies(self):
        shutil.rmtree(self.host_roots["agents"])
        bundle = self.resolve(topic="profiles", allow_partial=True, explain=True)
        self.assertTrue(bundle["partial"])
        self.assertTrue(all("content" not in d for d in bundle["documents"]))
        self.assertEqual(bundle["missingDocuments"][0]["id"], "host.agent-runtimes")
        rendered = resolver.render_context(bundle, explain=True)
        self.assertIn("required by: repo.bridge", rendered)

    def test_symlinked_host_root_is_never_partial(self):
        original = self.host_roots["agents"]
        renamed = self.base / "real-agents"
        original.rename(renamed)
        original.symlink_to(renamed, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe symlink"):
            self.resolve(topic="profiles", allow_partial=True)

    def test_symlinked_host_readme_is_never_partial(self):
        original = self.host_roots["agents"] / "README.md"
        original.unlink()
        original.symlink_to(ROOT / "templates/context/host-roots/agents/README.md")
        with self.assertRaisesRegex(ValueError, "Unsafe symlink"):
            self.resolve(topic="profiles", allow_partial=True)

    def test_symlinked_parent_of_selected_absolute_path_is_rejected(self):
        host = self.host_roots["agents"]
        (host / "codex").mkdir()
        alias = host / "shortcut"
        alias.symlink_to(host / "codex", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe symlink"):
            self.resolve(path=str(alias / "config.toml"), allow_partial=True)

    def test_symlinked_parent_of_relative_selection_is_rejected(self):
        repo = self.base / "repo"
        repo.mkdir()
        (repo / "shortcut").symlink_to(self.base / "private", target_is_directory=True)
        index = {"repo.test": {"applies_to": ["**"]}}
        manifest = {"documents": {"repo.test": {"root": "repo"}}}
        with self.assertRaisesRegex(ValueError, "Unsafe symlink"):
            resolver._owners_for_path("shortcut/private.txt", index, manifest, {"repo": repo})

    def test_absolute_selection_rejects_parent_traversal(self):
        path = str(self.host_roots["agents"] / ".." / "agent-tools" / "README.md")
        with self.assertRaisesRegex(ValueError, "Unsafe absolute context selection"):
            self.resolve(path=path, allow_partial=True)

    def test_missing_required_root_fails_even_with_partial_flag(self):
        previous = resolver.validate_context_contract

        def mark_required(repo):
            contract = copy.deepcopy(previous(repo))
            contract["manifest"]["roots"]["host-agents"]["required"] = True
            return contract

        shutil.rmtree(self.host_roots["agents"])
        with mock.patch.object(resolver, "validate_context_contract", side_effect=mark_required):
            with self.assertRaisesRegex(ValueError, "Required context root absent"):
                self.resolve(topic="profiles", allow_partial=True)

    def test_non_directory_root_is_not_an_optional_missing_source(self):
        shutil.rmtree(self.host_roots["agents"])
        self.host_roots["agents"].write_text("not a directory")
        with self.assertRaisesRegex(ValueError, "Invalid context directory"):
            self.resolve(topic="profiles", allow_partial=True)

    def test_existing_directory_instead_of_readme_is_not_partial(self):
        target = self.host_roots["agents"] / "README.md"
        target.unlink()
        target.mkdir()
        with self.assertRaisesRegex(ValueError, "not a regular file"):
            self.resolve(topic="profiles", allow_partial=True)

    def test_changed_host_readme_is_not_partial(self):
        source = self.host_roots["agents"] / "README.md"
        source.write_text(source.read_text() + "\nunsanctioned host change\n")
        with self.assertRaisesRegex(ValueError, "differs from reviewed Git source"):
            self.resolve(topic="profiles", allow_partial=True)

    def test_symlinked_path_components_must_not_leak_outside(self):
        private = self.base / "private"
        private.mkdir()
        (private / "README.md").write_text("private bytes")
        directory = self.host_roots["agents"] / "linked"
        directory.symlink_to(private, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe symlink"):
            require_context_source(directory / "README.md", self.host_roots["agents"],
                                   "host.agent-runtimes", optional=True)

    def test_partial_output_is_not_truncated(self):
        bundle = self.resolve(topic="profiles", allow_partial=True)
        for item in bundle["documents"]:
            source = Path(item["sourcePath"]).read_text()
            self.assertEqual(item["content"], source)
            self.assertIn(source, resolver.render_context(bundle))

    def test_metadata_duplicate_key_cycle_and_malformed_are_fail_closed(self):
        # The same C1 validator runs before any C4 selection or partial mode.
        # Use the actual reviewed contract to prove these errors are never
        # downgraded by allow_partial.
        from context_contract import load_unique_yaml
        with self.assertRaisesRegex(ValueError, "Duplicate context YAML key"):
            load_unique_yaml("context:\n  id: one\n  id: two\n")
        with mock.patch.object(
            resolver, "validate_context_contract",
            side_effect=ValueError("Context dependency cycle at repo.bridge"),
        ):
            with self.assertRaisesRegex(ValueError, "dependency cycle"):
                self.resolve(topic="profiles", allow_partial=True)
        with mock.patch.object(
            resolver, "validate_context_contract",
            side_effect=ValueError("malformed context frontmatter"),
        ):
            with self.assertRaisesRegex(ValueError, "malformed"):
                self.resolve(topic="profiles", allow_partial=True)


if __name__ == "__main__":
    unittest.main()
