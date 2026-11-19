"""ABR-73: verify portable CLI bootstrap without agent or service startup."""
import io
from contextlib import redirect_stdout, redirect_stderr
import os
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
            (["--version"], "agent-context 0.1.0"),
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

    def test_unsupported_commands_are_not_implemented_prematurely(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--topic", "profiles"],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)


if __name__ == "__main__":
    unittest.main()
