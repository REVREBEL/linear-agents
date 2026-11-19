"""ABR-76 C5: native-OS cross-root acceptance and deterministic context tests.

Uses temporary host roots and Git-owned README bytes. It never changes /opt,
native profiles, Bridge services or provider configuration.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

import context_resolver as resolver
from context_contract import (
    ContextSourceUnavailable, select_host_root, validate_context_contract,
    validate_relative_document_path,
)

ROOT = Path(__file__).resolve().parents[1]
HOSTS = (
    ("agents", "AGENT_CONTEXT_AGENTS_ROOT", "host.agent-runtimes"),
    ("agent-tools", "AGENT_CONTEXT_AGENT_TOOLS_ROOT", "host.agent-tools"),
    ("global-tools", "AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "host.global-tools"),
)
PROFILE_ORDER = (
    "host.global-tools", "host.agent-tools", "host.agent-runtimes",
    "repo.agents", "repo.bridge",
)


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def reviewed_bytes(path):
    return git(ROOT, "show", f"HEAD:{path}")


class CrossRootAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="abr76-cross-root-")
        self.addCleanup(self.temp.cleanup)
        # On macOS /var may be a symlink to /private/var; use the real path.
        self.base = Path(self.temp.name).resolve()
        self.environ = {}
        self.host_roots = {}
        for folder, name, _ in HOSTS:
            root = self.base / "host" / folder
            root.mkdir(parents=True)
            source = f"templates/context/host-roots/{folder}/README.md"
            (root / "README.md").write_bytes(reviewed_bytes(source))
            self.environ[name] = str(root)
            self.host_roots[folder] = root

    def bundle(self, **kwargs):
        return resolver.resolve_context(ROOT, environ=self.environ, **kwargs)

    def run_cli(self, *args):
        environment = os.environ.copy()
        environment.pop("AGENT_CONTEXT_REPO_ROOT", None)
        environment.update(self.environ)
        environment["PYTHONUTF8"] = "1"
        return subprocess.run(
            [
                sys.executable, str(ROOT / "scripts/agent_context_cli.py"),
                "--repo-root", str(ROOT), *args,
            ],
            cwd=self.base, env=environment,
            capture_output=True, text=True, encoding="utf-8",
        )

    def test_profile_topic_crosses_git_and_all_three_host_roots(self):
        bundle = self.bundle(topic="profiles")
        self.assertEqual(
            tuple(item["id"] for item in bundle["documents"]), PROFILE_ORDER
        )
        self.assertFalse(bundle["partial"])
        self.assertEqual(bundle["missingDocuments"], [])
        self.assertEqual(bundle["unmatchedPaths"], [])
        self.assertEqual(len(bundle["documents"]), len(set(PROFILE_ORDER)))
        self.assertEqual(bundle["gitHeadSha"], git(ROOT, "rev-parse", "HEAD").decode().strip())

    def test_dependency_order_and_shared_dependencies_are_unique(self):
        bundle = self.bundle(topic="profiles")
        lookup = {doc["id"]: i for i, doc in enumerate(bundle["documents"])}
        self.assertEqual(len(lookup), len(bundle["documents"]))
        self.assertLess(lookup["host.global-tools"], lookup["host.agent-tools"])
        self.assertLess(lookup["host.agent-tools"], lookup["repo.agents"])
        self.assertLess(lookup["repo.agents"], lookup["repo.bridge"])
        self.assertIn(
            "required by: repo.agents",
            bundle["documents"][lookup["host.global-tools"]]["reasons"],
        )
        self.assertIn(
            "required by: repo.bridge",
            bundle["documents"][lookup["host.agent-runtimes"]]["reasons"],
        )

    def test_all_five_original_readmes_are_exact_and_source_linked(self):
        bundle = self.bundle(topic="profiles")
        for doc in bundle["documents"]:
            with self.subTest(doc=doc["id"]):
                expected = reviewed_bytes(doc["gitSourcePath"])
                actual = Path(doc["sourcePath"]).read_bytes()
                self.assertEqual(actual, expected)
                self.assertEqual(doc["content"], actual.decode("utf-8"))
                self.assertEqual(doc["sha256"], hashlib.sha256(actual).hexdigest())
                self.assertFalse(doc["worktreeModified"])
                self.assertEqual(
                    doc["gitSha"],
                    git(ROOT, "log", "-1", "--format=%H", "--", doc["gitSourcePath"]).decode().strip(),
                )
                self.assertTrue(doc["reasons"])

    def test_git_agents_and_host_roots_can_be_selected_by_path(self):
        for path, doc_id in (
            ("agents/registry.json", "repo.agents"),
            *(
                (str(self.host_roots[folder] / "config.yaml"), owner)
                for folder, _, owner in HOSTS
            ),
        ):
            with self.subTest(path=path):
                bundle = self.bundle(path=path)
                seeds = [doc["id"] for doc in bundle["documents"]
                         if f"path: {path}" in doc["reasons"]]
                self.assertEqual(seeds, [doc_id])
                self.assertTrue(all("content" in doc for doc in bundle["documents"]))

    def test_absolute_host_root_directory_maps_to_owning_readme(self):
        for folder, _, expected in HOSTS:
            with self.subTest(folder=folder):
                path = str(self.host_roots[folder])
                bundle = self.bundle(path=path)
                seeds = [doc["id"] for doc in bundle["documents"]
                         if f"path: {path}" in doc["reasons"]]
                self.assertEqual(seeds, [expected])

    def test_live_cli_reads_full_cross_root_json_from_unrelated_directory(self):
        result = self.run_cli("--topic", "profiles", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        decoded = json.loads(result.stdout)
        self.assertEqual(decoded, self.bundle(topic="profiles"))
        self.assertEqual(tuple(v["id"] for v in decoded["documents"]), PROFILE_ORDER)
        self.assertTrue(all("content" in v for v in decoded["documents"]))

    def test_markdown_and_json_are_deterministic_without_truncation(self):
        a = self.bundle(topic="profiles")
        b = self.bundle(topic="profiles")
        self.assertEqual(a, b)
        self.assertEqual(
            resolver.render_context(a, output_format="json"),
            resolver.render_context(b, output_format="json"),
        )
        markdown = resolver.render_context(a, output_format="markdown")
        for item in a["documents"]:
            self.assertIn(item["content"], markdown)
            self.assertIn(item["gitSha"], markdown)
            self.assertIn(item["sourcePath"], markdown)
        first = self.run_cli("--topic", "profiles", "--format", "json")
        second = self.run_cli("--topic", "profiles", "--format", "json")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)

    def test_explain_has_same_document_order_and_reasons_without_bodies(self):
        full = self.bundle(topic="profiles")
        explain = self.bundle(topic="profiles", explain=True)
        self.assertEqual(
            [x["id"] for x in full["documents"]],
            [x["id"] for x in explain["documents"]],
        )
        for original, explained in zip(full["documents"], explain["documents"]):
            self.assertNotIn("content", explained)
            self.assertEqual(original["reasons"], explained["reasons"])
            self.assertEqual(original["gitSha"], explained["gitSha"])

    def test_root_overrides_precede_git_manifest_defaults(self):
        manifest = yaml.safe_load((ROOT / ".agents/context.yaml").read_text())
        for alias, folder in (
            ("host-agents", "agents"),
            ("host-agent-tools", "agent-tools"),
            ("host-global-tools", "global-tools"),
        ):
            with self.subTest(alias=alias):
                config = manifest["roots"][alias]
                self.assertEqual(
                    select_host_root(config, sys.platform, self.environ),
                    str(self.host_roots[folder]),
                )
                self.assertEqual(
                    str(next(doc for doc in self.bundle(topic="profiles")["documents"]
                             if doc["root"] == alias)["sourcePath"]),
                    str(self.host_roots[folder] / "README.md"),
                )

    def test_changing_override_updates_host_paths_but_not_source_hashes(self):
        before = self.bundle(topic="profiles")
        new_base = self.base / "another-install"
        for folder, var, _ in HOSTS:
            new_root = new_base / folder
            new_root.mkdir(parents=True)
            (new_root / "README.md").write_bytes(
                reviewed_bytes(f"templates/context/host-roots/{folder}/README.md")
            )
            self.environ[var] = str(new_root)
        after = self.bundle(topic="profiles")
        for earlier, later in zip(before["documents"], after["documents"]):
            self.assertEqual(earlier["id"], later["id"])
            self.assertEqual(earlier["sha256"], later["sha256"])
            self.assertEqual(earlier["gitSha"], later["gitSha"])
            self.assertEqual(earlier["content"], later["content"])
            self.assertEqual(earlier["reasons"], later["reasons"])
            if earlier["root"] != "repo":
                self.assertNotEqual(earlier["sourcePath"], later["sourcePath"])

    def test_missing_each_optional_host_readme_strict_and_partial(self):
        for folder, _, owner in HOSTS:
            with self.subTest(folder=folder):
                path = self.host_roots[folder] / "README.md"
                previous = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(ContextSourceUnavailable, owner):
                        self.bundle(topic="profiles")
                    partial = self.bundle(topic="profiles", allow_partial=True)
                    self.assertTrue(partial["partial"])
                    self.assertEqual([x["id"] for x in partial["missingDocuments"]], [owner])
                    self.assertEqual(
                        partial["missingDocuments"][0]["sourcePath"], str(path),
                    )
                    self.assertTrue(all("content" in x for x in partial["documents"]))
                    self.assertEqual(len(partial["documents"]), 4)
                finally:
                    path.write_bytes(previous)

    def test_missing_all_optional_roots_is_explicitly_reported(self):
        for folder, _, _ in HOSTS:
            shutil.rmtree(self.host_roots[folder])
        with self.assertRaisesRegex(ContextSourceUnavailable, "Context source missing"):
            self.bundle(topic="profiles")
        result = self.bundle(topic="profiles", allow_partial=True)
        self.assertTrue(result["partial"])
        self.assertEqual(
            {doc["id"] for doc in result["missingDocuments"]},
            {"host.agent-runtimes", "host.agent-tools", "host.global-tools"},
        )
        self.assertEqual(
            [doc["id"] for doc in result["documents"]], ["repo.agents", "repo.bridge"]
        )
        for missing in result["missingDocuments"]:
            self.assertTrue(missing["reasons"] and missing["sourcePath"] and missing["error"])

    def make_git_fixture(self):
        """Create an isolated reviewed complete source tree for negative cases."""
        repo = self.base / "fixture-repo"
        manifest = yaml.safe_load((ROOT / ".agents/context.yaml").read_text())
        source_files = {
            ".agents/context.yaml",
            "templates/context/context-manifest.schema.json",
            "templates/context/context-frontmatter.schema.json",
            *(
                locator["path"] for locator in manifest["documents"].values()
                if locator["root"] == "repo"
            ),
            *resolver.HOST_SOURCE_DOCS.values(),
        }
        for source in source_files:
            target = repo / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(reviewed_bytes(source))
        git(repo, "init", "-q")
        git(repo, "add", ".")
        git(
            repo, "-c", "user.email=context-fixture@example.invalid",
            "-c", "user.name=Context Fixture", "commit", "-qm", "reviewed baseline"
        )
        return repo

    def test_real_duplicate_key_in_fixture_fails_before_retrieval(self):
        repo = self.make_git_fixture()
        path = repo / ".agents/context.yaml"
        content = path.read_text(encoding="utf-8")
        key = "  repo.agents: {root: repo, path: agents/README.md}\n"
        self.assertIn(key, content)
        path.write_text(content.replace(key, key + key, 1), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate context YAML key"):
            resolver.resolve_context(repo, topic="profiles", environ=self.environ,
                                     allow_partial=True)

    def test_real_dependency_cycle_in_fixture_fails_before_retrieval(self):
        repo = self.make_git_fixture()
        path = repo / "agents/README.md"
        source = path.read_text(encoding="utf-8")
        marker = "requires: [host.agent-runtimes, host.agent-tools, host.global-tools]"
        self.assertIn(marker, source)
        path.write_text(
            source.replace(marker, marker.replace("requires: [", "requires: [repo.bridge, "), 1),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "Context dependency cycle"):
            resolver.resolve_context(repo, topic="profiles", environ=self.environ,
                                     allow_partial=True)

    def test_missing_required_repository_readme_is_never_partial(self):
        repo = self.make_git_fixture()
        (repo / "agents/README.md").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or escaping repository"):
            resolver.resolve_context(repo, topic="profiles", environ=self.environ,
                                     allow_partial=True)

    def test_changed_file_handoff_crosses_repo_owners_and_lists_unmatched(self):
        repo = self.make_git_fixture()
        changed_readme = repo / "agents/README.md"
        changed_readme.write_bytes(changed_readme.read_bytes() + b"\nReviewed content change\n")
        for relative in (
            "memory/migrations/001_agent_checkpoints.sql",
            "integrations/openrouter/agent-runtime.mjs",
            "scripts/unknown-source.txt",
        ):
            path = repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture change", encoding="utf-8")
        bundle = resolver.resolve_context(
            repo, files_changed=True, environ=self.environ,
        )
        self.assertEqual(
            bundle["selection"]["mode"], "files-changed"
        )
        self.assertEqual(bundle["unmatchedPaths"], ["scripts/unknown-source.txt"])
        reasons = {doc["id"]: doc["reasons"] for doc in bundle["documents"]}
        self.assertIn("changed file: agents/README.md", reasons["repo.agents"])
        self.assertIn(
            "changed file: memory/migrations/001_agent_checkpoints.sql",
            reasons["repo.memory.migrations"],
        )
        self.assertIn(
            "changed file: integrations/openrouter/agent-runtime.mjs",
            reasons["repo.integrations.openrouter"],
        )
        self.assertEqual(
            len(bundle["documents"]), len(set(x["id"] for x in bundle["documents"]))
        )
        self.assertEqual(
            json.loads(resolver.render_context(bundle, output_format="json")), bundle
        )

    def test_standalone_committed_zipapp_retrieves_same_bundle(self):
        spec = importlib.util.spec_from_file_location(
            "agent_context_c5_installer", ROOT / "scripts/install-agent-context.py"
        )
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        sources, metadata = installer.validated_sources()
        executable = self.base / "agent-context.pyz"
        executable.write_bytes(installer.archive_bytes(sources, metadata))
        environment = os.environ.copy()
        environment.pop("AGENT_CONTEXT_REPO_ROOT", None)
        environment.update(self.environ)
        environment["PYTHONUTF8"] = "1"
        result = subprocess.run(
            [
                sys.executable, str(executable), "--repo-root", str(ROOT),
                "--topic", "profiles", "--format", "json",
            ],
            cwd=self.base, env=environment,
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), self.bundle(topic="profiles"))

    def test_native_platform_override_retrieval_runs_without_opt_roots(self):
        platform = "win32" if sys.platform == "win32" else (
            "darwin" if sys.platform == "darwin" else "linux"
        )
        bundle = resolver.resolve_context(
            ROOT, topic="profiles", environ=self.environ, platform=platform,
        )
        self.assertEqual(
            tuple(item["id"] for item in bundle["documents"]), PROFILE_ORDER
        )


class CrossPlatformPathContracts(unittest.TestCase):
    def test_critical_context_sources_have_native_lf_checkout_policy(self):
        sources = (
            ".agents/context.yaml", ".agents/README.md",
            "agents/README.md", "bridge/README.md", "jobs/README.md",
            "memory/README.md", "memory/migrations/README.md",
            "integrations/README.md", "integrations/openrouter/README.md",
            "templates/context/host-roots/agents/README.md",
            "templates/context/context-manifest.schema.json",
            "scripts/agent_context_cli.py", "scripts/context_contract.py",
            "scripts/context_resolver.py", "scripts/install-agent-context.py",
        )
        for source in sources:
            with self.subTest(source=source):
                policy = git(ROOT, "check-attr", "eol", "--", source)
                self.assertIn(b": eol: lf", policy, policy.decode())

    def test_platform_defaults_and_env_override_precedence(self):
        config = {
            "environment": "AGENT_CONTEXT_TEST_ROOT",
            "default": "/opt/agents",
            "required": False,
            "platformDefaults": {
                "darwin": "/Users/agent/agents",
                "win32": "C:\\agent-tools\\agents",
            },
        }
        for platform, expected in (
            ("linux", "/opt/agents"),
            ("darwin", "/Users/agent/agents"),
            ("win32", "C:\\agent-tools\\agents"),
        ):
            with self.subTest(platform=platform):
                self.assertEqual(select_host_root(config, platform, {}), expected)
        for platform, value in (
            ("linux", "/home/bridge/agents"),
            ("darwin", "/private/opt/agents"),
            ("win32", "D:\\agents\\models"),
        ):
            with self.subTest(platform=platform):
                self.assertEqual(
                    select_host_root(
                        config, platform, {"AGENT_CONTEXT_TEST_ROOT": value}
                    ), value
                )

    def test_invalid_native_os_paths_fail_instead_of_falling_back(self):
        config = {"environment": "AGENT_CONTEXT_TEST_ROOT", "default": "/opt/agents"}
        for platform, value in (
            ("linux", "relative/agents"),
            ("linux", "C:\\AgentHome"),
            ("darwin", "/Users/../private"),
            ("win32", "/opt/agents"),
            ("win32", "C:relative"),
            ("win32", "C:\\Users\\..\\secret"),
        ):
            with self.subTest(platform=platform, value=value):
                with self.assertRaisesRegex(ValueError, "Invalid absolute"):
                    select_host_root(
                        config, platform, {"AGENT_CONTEXT_TEST_ROOT": value}
                    )
        with self.assertRaisesRegex(ValueError, "Invalid absolute win32"):
            select_host_root(config, "win32", {})

    def test_relative_alias_paths_are_portable_posix_not_native_windows(self):
        self.assertEqual(
            validate_relative_document_path("memory/migrations/README.md"),
            "memory/migrations/README.md",
        )
        for invalid in (
            "../config.md", "./README.md", "agents//README.md",
            "agents\\README.md", "C:\\agents\\README.md",
            "/opt/agents/README.md", "memory/../README.md",
        ):
            with self.subTest(path=invalid):
                with self.assertRaisesRegex(ValueError, "Unsafe relative"):
                    validate_relative_document_path(invalid)


if __name__ == "__main__":
    unittest.main()
