"""ABR-74 C3: context selection, recursive dependencies and source provenance."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import context_resolver as resolver

ROOT = Path(__file__).resolve().parents[1]
HOST_DOCS = (
    ("AGENT_CONTEXT_AGENTS_ROOT", "agents"),
    ("AGENT_CONTEXT_AGENT_TOOLS_ROOT", "agent-tools"),
    ("AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "global-tools"),
)


class AgentContextResolverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = {}
        self.roots = {}
        for key, folder in HOST_DOCS:
            root = Path(self.temp.name) / folder
            root.mkdir()
            shutil.copy2(
                ROOT / "templates/context/host-roots" / folder / "README.md",
                root / "README.md",
            )
            self.env[key] = str(root)
            self.roots[folder] = root

    def resolve(self, **kwargs):
        return resolver.resolve_context(ROOT, environ=self.env, **kwargs)

    def test_profile_topic_has_cross_root_dependencies_and_no_duplicates(self):
        result = self.resolve(topic="profiles")
        ids = [doc["id"] for doc in result["documents"]]
        self.assertEqual(len(ids), len(set(ids)))
        for doc in ("repo.agents", "repo.bridge", "host.agent-runtimes",
                    "host.agent-tools", "host.global-tools"):
            self.assertIn(doc, ids)
        self.assertLess(ids.index("host.global-tools"), ids.index("host.agent-tools"))
        self.assertLess(ids.index("host.agent-tools"), ids.index("repo.agents"))
        self.assertTrue(all(len(item["gitSha"]) == 40 for item in result["documents"]))

    def test_topic_selection_is_case_insensitive(self):
        a = self.resolve(topic="profiles")
        b = self.resolve(topic="PROFILES")
        self.assertEqual(
            [doc["id"] for doc in a["documents"]],
            [doc["id"] for doc in b["documents"]],
        )

    def test_path_selects_nearest_nested_owner(self):
        result = self.resolve(path="memory/migrations/001_agent_checkpoints.sql")
        migrations = next(item for item in result["documents"] if item["id"] == "repo.memory.migrations")
        self.assertIn("path: memory/migrations/001_agent_checkpoints.sql", migrations["reasons"])
        self.assertNotIn(
            "path: memory/migrations/001_agent_checkpoints.sql",
            next(item for item in result["documents"] if item["id"] == "repo.memory")["reasons"],
        )

    def test_path_nested_provider_picks_specific_owner(self):
        result = self.resolve(path="integrations/openrouter/agent-runtime.mjs")
        self.assertTrue(any(
            item["id"] == "repo.integrations.openrouter" and
            "path: integrations/openrouter/agent-runtime.mjs" in item["reasons"]
            for item in result["documents"]
        ))

    def test_absolute_host_path_selects_declared_root(self):
        path = str(self.roots["agents"] / "codex" / "config.yaml")
        result = self.resolve(path=path)
        item = next(item for item in result["documents"] if item["id"] == "host.agent-runtimes")
        self.assertIn(f"path: {path}", item["reasons"])

    def test_document_bodies_are_exact_and_not_truncated(self):
        bundle = self.resolve(topic="profiles")
        repo_doc = next(doc for doc in bundle["documents"] if doc["id"] == "repo.agents")
        host_doc = next(doc for doc in bundle["documents"] if doc["id"] == "host.agent-runtimes")
        self.assertEqual(repo_doc["content"], (ROOT / "agents/README.md").read_text())
        self.assertEqual(host_doc["content"], (self.roots["agents"] / "README.md").read_text())
        self.assertEqual(len(repo_doc["sha256"]), 64)
        self.assertEqual(repo_doc["gitSourcePath"], "agents/README.md")
        rendered = resolver.render_context(bundle)
        self.assertIn(repo_doc["content"], rendered)
        self.assertIn(host_doc["content"], rendered)

    def test_json_preserves_full_text_and_source_reasons(self):
        bundle = self.resolve(topic="profiles")
        decoded = json.loads(resolver.render_context(bundle, output_format="json"))
        self.assertEqual(decoded, bundle)
        self.assertTrue(all(item["reasons"] for item in bundle["documents"]))
        self.assertEqual(decoded["selection"]["mode"], "topic")

    def test_explain_omits_bodies_but_retains_reasons_and_paths(self):
        bundle = self.resolve(explain=True, path="jobs/lifecycle/agent-session.mjs")
        self.assertTrue(bundle["documents"])
        for item in bundle["documents"]:
            self.assertNotIn("content", item)
            self.assertTrue(item["sourcePath"])
            self.assertTrue(item["reasons"])
        explanation = resolver.render_context(bundle, explain=True)
        self.assertIn("Git source:", explanation)
        self.assertIn("Included because:", explanation)

    def test_default_selects_bootstrap_entrypoint(self):
        bundle = self.resolve()
        bootstrap = next(item for item in bundle["documents"] if item["id"] == "repo.bootstrap")
        self.assertIn("entrypoint: default", bootstrap["reasons"])

    def test_deterministic_output(self):
        a = resolver.render_context(self.resolve(topic="profiles"), output_format="json")
        b = resolver.render_context(self.resolve(topic="profiles"), output_format="json")
        self.assertEqual(a, b)

    def test_missing_host_dependency_fails_with_explicit_source(self):
        (self.roots["agent-tools"] / "README.md").unlink()
        with self.assertRaisesRegex(ValueError, "Context source missing"):
            self.resolve(topic="profiles")

    def test_drifted_host_readme_is_not_claimed_as_git_source(self):
        doc = self.roots["agent-tools"] / "README.md"
        doc.write_text(doc.read_text() + "\nlocal unauthorized content\n")
        with self.assertRaisesRegex(ValueError, "differs from reviewed Git source"):
            self.resolve(topic="profiles")

    def test_path_traversal_and_unknown_topic_fail(self):
        with self.assertRaisesRegex(ValueError, "Unsafe relative"):
            self.resolve(path="../private")
        with self.assertRaisesRegex(ValueError, "No owning context documents"):
            self.resolve(topic="nonexistent-topic")

    def test_files_changed_uses_nearest_owners_and_lists_uncovered(self):
        files = [
            "agents/registry.json",
            "memory/migrations/001_agent_checkpoints.sql",
            "scripts/agent_context_cli.py",
        ]
        with mock.patch.object(resolver, "_changed_files", return_value=files):
            bundle = self.resolve(files_changed=True)
        self.assertEqual(bundle["unmatchedPaths"], ["scripts/agent_context_cli.py"])
        ids = [doc["id"] for doc in bundle["documents"]]
        self.assertIn("repo.agents", ids)
        self.assertIn("repo.memory.migrations", ids)
        self.assertEqual(bundle["selection"]["value"], files)
        self.assertTrue(any(
            "changed file: agents/registry.json" in item["reasons"]
            for item in bundle["documents"]
        ))

    def test_files_changed_requires_actual_changes(self):
        with mock.patch.object(resolver, "_changed_files", return_value=[]):
            with self.assertRaisesRegex(ValueError, "No Git changed"):
                self.resolve(files_changed=True)

    def test_git_changed_file_discovery_includes_tracked_and_untracked(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "tracked.txt").write_text("original")
            subprocess.run(["git", "-C", folder, "init", "-q"], check=True)
            subprocess.run(["git", "-C", folder, "add", "tracked.txt"], check=True)
            subprocess.run([
                "git", "-C", folder, "-c", "user.email=fixture@example.com",
                "-c", "user.name=Fixture", "commit", "-qm", "initial",
            ], check=True)
            (base / "tracked.txt").write_text("updated")
            (base / "new.txt").write_text("new")
            self.assertEqual(resolver._changed_files(base), ["new.txt", "tracked.txt"])


if __name__ == "__main__":
    unittest.main()
