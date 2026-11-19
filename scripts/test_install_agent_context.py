"""ABR-73: deterministic, guarded CLI publication with isolated destinations."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "agent_context_installer", ROOT / "scripts/install-agent-context.py"
)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class AgentContextInstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin_dir = self.root / "agent-tools/bin"
        self.bin_dir.mkdir(parents=True)
        self.target = self.bin_dir / "agent-context"
        self.sources, self.metadata = installer.validated_sources()
        self.artifact = installer.archive_bytes(self.sources, self.metadata)

    def test_reviewed_binary_is_deterministic(self):
        self.assertEqual(self.artifact, installer.archive_bytes(self.sources, self.metadata))
        self.assertEqual(len(self.metadata["sourceCommit"]), 40)
        self.assertEqual(set(self.metadata["sources"]), set(installer.SOURCES))
        with zipfile.ZipFile(self.make_archive()) as binary:
            self.assertEqual(set(binary.namelist()), installer.ARCHIVE_FILES)
            self.assertEqual(json.loads(binary.read(installer.MANIFEST)), self.metadata)

    def make_archive(self):
        path = self.root / "build-agent-context.pyz"
        path.write_bytes(self.artifact)
        return path

    def test_installed_zipapp_runs_outside_git_checkout(self):
        binary = self.make_archive()
        for args, expected in (
            (["--version"], "agent-context 0.1.0"),
            (["--repo-root", str(ROOT), "validate"], "13 source-backed README contracts"),
        ):
            with self.subTest(args=args):
                proc = subprocess.run(
                    [sys.executable, str(binary), *args],
                    cwd=self.root, capture_output=True, text=True,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn(expected, proc.stdout)

    def test_missing_install_and_read_only_check(self):
        self.assertEqual(installer.check_install(self.target, self.artifact), 1)
        self.assertFalse(self.target.exists())

    def test_install_and_repeat_are_identical(self):
        self.assertEqual(installer.install(self.target, self.artifact), 0)
        self.assertEqual(installer.check_install(self.target, self.artifact), 0)
        self.assertTrue(os.access(self.target, os.X_OK))
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)
        self.assertEqual(installer.install(self.target, self.artifact), 0)
        self.assertEqual(list(self.bin_dir.glob("agent-context.backup-*")), [])

    def test_check_detects_and_apply_repairs_non_executable_mode(self):
        installer.install(self.target, self.artifact)
        self.target.chmod(0o644)
        self.assertEqual(installer.check_install(self.target, self.artifact), 1)
        self.assertEqual(installer.install(self.target, self.artifact), 0)
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o755)
        self.assertEqual(installer.check_install(self.target, self.artifact), 0)

    def test_reviewed_update_retains_backup_without_install_gap(self):
        installer.install(self.target, self.artifact)
        updated_sources = dict(self.sources)
        updated_sources["agent_context_cli.py"] += b"\n# Reviewed update\n"
        updated_meta = installer.build_metadata(updated_sources, "b" * 40)
        updated_artifact = installer.archive_bytes(updated_sources, updated_meta)
        self.assertEqual(installer.check_install(self.target, updated_artifact), 1)
        real_replace = installer.os.replace

        def observe(staged, target):
            self.assertEqual(Path(target).read_bytes(), self.artifact)
            real_replace(staged, target)
            self.assertEqual(Path(target).read_bytes(), updated_artifact)

        with mock.patch.object(installer.os, "replace", side_effect=observe):
            self.assertEqual(installer.install(self.target, updated_artifact), 0)
        self.assertEqual(self.target.read_bytes(), updated_artifact)
        backups = list(self.bin_dir.glob("agent-context.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.artifact)

    def test_refuse_existing_unmanaged_file(self):
        self.target.write_text("#!/bin/sh\necho not managed\n")
        with self.assertRaisesRegex(ValueError, "Unmanaged executable"):
            installer.install(self.target, self.artifact)
        self.assertIn("not managed", self.target.read_text())

    def test_refuse_tampered_managed_zipapp(self):
        installer.install(self.target, self.artifact)
        data = self.target.read_bytes()
        self.assertIn(b'CLI_VERSION = "0.1.0"', data)
        self.target.write_bytes(data.replace(b'CLI_VERSION = "0.1.0"', b'CLI_VERSION = "9.9.9"'))
        with self.assertRaisesRegex(ValueError, "Unmanaged|Modified managed|digest mismatch"):
            installer.install(self.target, self.artifact)

    def test_refuse_symlink_executable(self):
        other = self.root / "private"
        other.write_text("do not overwrite")
        self.target.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "Unsafe agent-context executable target"):
            installer.install(self.target, self.artifact)
        self.assertEqual(other.read_text(), "do not overwrite")

    def test_refuse_symlink_parent(self):
        self.bin_dir.rmdir()
        self.bin_dir.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "existing real directory"):
            installer.install(self.target, self.artifact)

    def test_preserves_neighboring_executables(self):
        other = self.bin_dir / "agent-exec"
        other.write_text("existing wrapper")
        installer.install(self.target, self.artifact)
        self.assertEqual(other.read_text(), "existing wrapper")

    def test_source_drift_hidden_by_assume_unchanged_is_rejected(self):
        fixture = self.root / "fixture"
        for path in installer.SOURCES.values():
            destination = fixture / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, destination)

        def git(*arguments):
            subprocess.run(
                ["git", "-C", str(fixture), *arguments], check=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )

        git("init", "-q")
        git("add", "scripts")
        git("-c", "user.email=fixture@example.com", "-c", "user.name=Fixture",
            "commit", "-qm", "reviewed source")
        edited = fixture / "scripts/agent_context_cli.py"
        git("update-index", "--assume-unchanged", "scripts/agent_context_cli.py")
        edited.write_text(edited.read_text() + "\n# unreviewed edit\n")
        with mock.patch.object(installer, "ROOT", fixture):
            with self.assertRaisesRegex(ValueError, "differs from committed Git blob"):
                installer.validated_sources()


if __name__ == "__main__":
    unittest.main()
