"""ABR-69: exercise reviewed host-only README reconciliation in temporary roots."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "host_readme_reconciler", HERE / "scripts/reconcile-host-root-readmes.py"
)
reconcile = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reconcile)


class HostRootReadmeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "opt"
        self.root.mkdir()
        for folder in reconcile.DOCS:
            (self.root / folder).mkdir()
        self.sources = reconcile.reviewed_sources()

    def test_reviewed_sources_have_expected_context_ids(self):
        self.assertEqual(set(self.sources), set(reconcile.DOCS))
        for folder, data in self.sources.items():
            self.assertIn(reconcile.DOCS[folder].encode(), data)
            self.assertIn(b"<!-- Managed source:", data)

    def test_fresh_host_check_reports_missing(self):
        self.assertEqual(reconcile.check_host(self.root, self.sources), 1)

    def test_install_and_idempotent_check(self):
        self.assertEqual(reconcile.install_host(self.root, self.sources), 0)
        self.assertEqual(reconcile.check_host(self.root, self.sources), 0)
        self.assertEqual(reconcile.install_host(self.root, self.sources), 0)
        for folder in reconcile.DOCS:
            self.assertEqual(list((self.root / folder).glob("README.md.backup-*")), [])

    def test_preserve_backup_mode_on_managed_drift(self):
        reconcile.install_host(self.root, self.sources)
        target = self.root / "agents" / "README.md"
        altered = target.read_text() + "\nLocal reviewed update pending\n"
        target.write_text(altered)
        os.chmod(target, 0o640)
        self.assertEqual(reconcile.check_host(self.root, self.sources), 1)
        reconcile.install_host(self.root, self.sources)
        self.assertEqual(target.read_bytes(), self.sources["agents"])
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        backups = list(target.parent.glob("README.md.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), altered)

    def test_refuse_unmanaged_file_before_any_writes(self):
        (self.root / "global-tools" / "README.md").write_text("# Not managed\n")
        with self.assertRaisesRegex(ValueError, "unmanaged host README"):
            reconcile.install_host(self.root, self.sources)
        self.assertFalse((self.root / "agents" / "README.md").exists())

    def test_refuse_symlink_target_and_parent(self):
        (self.root / "agents" / "README.md").symlink_to(self.root / "global-tools")
        with self.assertRaisesRegex(ValueError, "non-regular or symlink"):
            reconcile.install_host(self.root, self.sources)
        (self.root / "agents" / "README.md").unlink()
        (self.root / "agents").rmdir()
        (self.root / "agents").symlink_to(self.root / "global-tools", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real existing host root"):
            reconcile.install_host(self.root, self.sources)

    def test_does_not_touch_neighboring_runtime_files(self):
        sentinel = self.root / "agents" / "private-runtime-sentinel"
        sentinel.write_text("keep this unchanged")
        reconcile.install_host(self.root, self.sources)
        self.assertEqual(sentinel.read_text(), "keep this unchanged")
        self.assertEqual(sorted((self.root / "agents").iterdir()),
                         sorted([sentinel, self.root / "agents" / "README.md"]))


if __name__ == "__main__":
    unittest.main()
