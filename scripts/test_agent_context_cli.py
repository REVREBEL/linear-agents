"""ABR-73: verify portable CLI bootstrap without agent or service startup."""
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import agent_context_cli as cli

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/agent_context_cli.py"


class ContextCliTests(unittest.TestCase):
    def test_help_and_version_are_portable(self):
        for args, text in (
            (["--help"], "validate"),
            (["--version"], "agent-context 0.3.0"),
        ):
            with self.subTest(args=args):
                outcome = subprocess.run(
                    [sys.executable, str(SCRIPT), *args],
                    capture_output=True, text=True, cwd=tempfile.gettempdir(),
                )
                self.assertEqual(outcome.returncode, 0, outcome.stderr)
                self.assertIn(text, outcome.stdout)

    def test_validate_with_explicit_repo_root(self):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo-root", str(ROOT), "validate"],
            cwd=tempfile.gettempdir(), capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("13 source-backed README contracts", proc.stdout)

    def test_find_from_nested_working_directory(self):
        self.assertEqual(
            cli.find_repo_root(cwd=ROOT / "jobs", environ={}), ROOT.resolve()
        )

    def test_nearest_manifest_wins_even_when_nested_schema_is_missing(self):
        # Reproduce the review finding: a nested project has a manifest
        # but lacks its C1 schema, while its ancestor is a valid project.
        with tempfile.TemporaryDirectory(prefix="context-nested-", dir=ROOT) as folder:
            nested = Path(folder) / "subproject"
            (nested / ".agents").mkdir(parents=True)
            (nested / ".agents/context.yaml").write_text(
                "contextVersion: invalid\\n", encoding="utf-8"
            )
            child = nested / "src" / "module"
            child.mkdir(parents=True)
            self.assertEqual(cli.find_repo_root(cwd=child, environ={}), nested.resolve())
            env = os.environ.copy()
            env.pop("AGENT_CONTEXT_REPO_ROOT", None)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "validate"],
                cwd=child, env=env, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn("agent-context:", result.stderr)
            self.assertIn(str(nested), result.stderr)
            self.assertNotIn("Validated Agent Context", result.stdout)

    def test_environment_selects_existing_repo(self):
        self.assertEqual(cli.find_repo_root(
            cwd=Path(tempfile.gettempdir()),
            environ={"AGENT_CONTEXT_REPO_ROOT": str(ROOT)},
        ), ROOT.resolve())

    def test_explicit_root_takes_precedence(self):
        self.assertEqual(cli.find_repo_root(
            str(ROOT), cwd=Path(tempfile.gettempdir()),
            environ={"AGENT_CONTEXT_REPO_ROOT": "/nonexistent/explicitly-ignored"},
        ), ROOT.resolve())

    def test_invalid_env_does_not_fall_back(self):
        with self.assertRaisesRegex(ValueError, "must be a nonempty path"):
            cli.find_repo_root(environ={"AGENT_CONTEXT_REPO_ROOT": ""}, cwd=ROOT)
        with self.assertRaisesRegex(ValueError, "does not exist"):
            cli.find_repo_root(
                environ={"AGENT_CONTEXT_REPO_ROOT": "/not-a-real-context-root"},
                cwd=ROOT,
            )

    def test_missing_repository_has_explanatory_exit(self):
        with tempfile.TemporaryDirectory() as empty:
            with mock.patch.dict(os.environ, {"AGENT_CONTEXT_REPO_ROOT": ""}):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "validate"],
                    cwd=empty, capture_output=True, text=True,
                )
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be a nonempty path", result.stderr)

    def test_invalid_manifest_returns_failure_without_traceback(self):
        with tempfile.TemporaryDirectory() as empty:
            root = Path(empty)
            (root / ".agents").mkdir()
            (root / ".agents/context.yaml").write_text("contextVersion: invalid\n")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--repo-root", str(root), "validate"],
                capture_output=True, text=True,
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn("agent-context:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_unknown_selector_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--not-an-option", "profiles"],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)

    def test_validate_rejects_selection_flags(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "validate", "--topic", "profiles"],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("validate does not accept", result.stderr)

    def test_validate_rejects_partial_option(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "validate", "--allow-partial"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("validate does not accept", result.stderr)

    def test_missing_host_doc_requires_explicit_cli_opt_in(self):
        with tempfile.TemporaryDirectory() as folder:
            env = os.environ.copy()
            env.pop("AGENT_CONTEXT_REPO_ROOT", None)
            for key, name in (
                ("AGENT_CONTEXT_AGENTS_ROOT", "agents"),
                ("AGENT_CONTEXT_AGENT_TOOLS_ROOT", "agent-tools"),
                ("AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "global-tools"),
            ):
                host = Path(folder) / name
                env[key] = str(host)
                if name != "agents":
                    host.mkdir()
                    shutil.copy2(
                        ROOT / "templates/context/host-roots" / name / "README.md",
                        host / "README.md",
                    )
            args = [
                sys.executable, str(SCRIPT), "--repo-root", str(ROOT),
                "--topic", "profiles", "--format", "json",
            ]
            denied = subprocess.run(
                args, cwd=folder, env=env, capture_output=True, text=True,
            )
            allowed = subprocess.run(
                [*args, "--allow-partial"], cwd=folder, env=env,
                capture_output=True, text=True,
            )
        self.assertEqual(denied.returncode, 2, denied.stdout)
        self.assertIn("Context source missing", denied.stderr)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        bundle = json.loads(allowed.stdout)
        self.assertTrue(bundle["partial"])
        self.assertEqual(
            [item["id"] for item in bundle["missingDocuments"]],
            ["host.agent-runtimes"],
        )
        self.assertTrue(all("content" in doc for doc in bundle["documents"]))

    def test_explain_reports_source_reasons(self):
        with tempfile.TemporaryDirectory() as folder:
            env = os.environ.copy()
            env.pop("AGENT_CONTEXT_REPO_ROOT", None)
            for key, name in (
                ("AGENT_CONTEXT_AGENTS_ROOT", "agents"),
                ("AGENT_CONTEXT_AGENT_TOOLS_ROOT", "agent-tools"),
                ("AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "global-tools"),
            ):
                target = Path(folder) / name
                target.mkdir()
                shutil.copy2(
                    ROOT / "templates/context/host-roots" / name / "README.md",
                    target / "README.md",
                )
                env[key] = str(target)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "explain", "--topic", "jobs", "--format", "json"],
                capture_output=True, text=True, cwd=ROOT, env=env,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        import json
        bundle = json.loads(result.stdout)
        self.assertTrue(any(item["id"] == "repo.jobs" for item in bundle["documents"]))
        self.assertTrue(all("content" not in item for item in bundle["documents"]))


if __name__ == "__main__":
    unittest.main()
