"""ABR-71: test idempotent, source-linked context publication without writing /opt."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "publish_context_templates", ROOT / "scripts/publish-context-templates.py"
)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class TemplatePublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "agent-tools"
        self.base.mkdir()
        self.dest = self.base / "templates" / "context"
        self.files, self.expected = publisher.reviewed_sources()

    def test_git_sources_are_versioned_and_complete(self):
        self.assertGreaterEqual(len(self.files), 14)
        self.assertTrue(publisher.REQUIRED.issubset(self.files))
        self.assertEqual(len(self.expected["sourceCommit"]), 40)
        self.assertEqual(self.expected["templateSet"], "agent-context")
        self.assertEqual(self.expected["schemaVersion"], 1)
        self.assertEqual(self.expected, publisher.snapshot(self.files, self.expected["sourceCommit"]))

    def test_initial_check_is_read_only(self):
        self.assertEqual(publisher.check_install(self.dest, self.expected), 1)
        self.assertFalse(self.dest.parent.exists())

    def test_install_and_repeat_are_idempotent(self):
        self.assertEqual(publisher.publish(self.dest, self.files, self.expected), 0)
        self.assertEqual(publisher.check_install(self.dest, self.expected), 0)
        manifest = (self.dest / publisher.MANIFEST).read_bytes()
        self.assertEqual(publisher.publish(self.dest, self.files, self.expected), 0)
        self.assertEqual((self.dest / publisher.MANIFEST).read_bytes(), manifest)
        self.assertEqual(list(self.dest.parent.glob("context.backup-*")), [])

    def test_reviewed_source_update_retains_prior_snapshot(self):
        publisher.publish(self.dest, self.files, self.expected)
        fresh = copy.deepcopy(self.files)
        fresh["README.md"] = self.files["README.md"] + b"\nReviewed version two\n"
        new_revision = "a" * 40
        updated = publisher.snapshot(fresh, new_revision)
        self.assertEqual(publisher.check_install(self.dest, updated), 1)
        publisher.publish(self.dest, fresh, updated)
        self.assertEqual(publisher.check_install(self.dest, updated), 0)
        backups = list(self.dest.parent.glob("context.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "README.md").read_bytes(), self.files["README.md"])

    def test_refuse_unmanaged_existing_directory(self):
        self.dest.mkdir(parents=True)
        (self.dest / "README.md").write_text("user owned")
        with self.assertRaisesRegex(ValueError, "Unmanaged context directory"):
            publisher.publish(self.dest, self.files, self.expected)
        self.assertEqual((self.dest / "README.md").read_text(), "user owned")

    def test_refuse_modification_to_installed_managed_file(self):
        publisher.publish(self.dest, self.files, self.expected)
        target = self.dest / "README.md"
        target.write_text("unexpected local change")
        with self.assertRaisesRegex(ValueError, "Modified managed"):
            publisher.publish(self.dest, self.files, self.expected)
        self.assertEqual(target.read_text(), "unexpected local change")

    def test_refuse_unmanaged_addition_without_deleting_it(self):
        publisher.publish(self.dest, self.files, self.expected)
        extra = self.dest / "private.txt"
        extra.write_text("never delete")
        with self.assertRaisesRegex(ValueError, "Unmanaged or missing"):
            publisher.publish(self.dest, self.files, self.expected)
        self.assertEqual(extra.read_text(), "never delete")

    def test_refuse_unmanaged_empty_directory(self):
        publisher.publish(self.dest, self.files, self.expected)
        empty = self.dest / "unmanaged-folder"
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, "Unmanaged or missing"):
            publisher.publish(self.dest, self.files, self.expected)
        self.assertTrue(empty.is_dir())

    def test_refuse_symlink_target_or_parent(self):
        self.dest.parent.mkdir()
        self.dest.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe managed template installation"):
            publisher.publish(self.dest, self.files, self.expected)
        self.dest.unlink()
        self.dest.parent.rmdir()
        self.dest.parent.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe managed template parent"):
            publisher.publish(self.dest, self.files, self.expected)

    def test_refuse_hidden_or_parent_escape_paths(self):
        for value in ("../secret.md", "/etc/passwd.md", ".env", "foo/.secrets.md", "a\\b.md"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                publisher.normalize_file(value)

    def test_runtime_neighbors_are_untouched(self):
        sentinel = self.base / "bin" / "launcher"
        sentinel.parent.mkdir()
        sentinel.write_text("retained native wrapper")
        publisher.publish(self.dest, self.files, self.expected)
        self.assertEqual(sentinel.read_text(), "retained native wrapper")

    def test_manifest_is_readable_and_uses_only_hashes(self):
        publisher.publish(self.dest, self.files, self.expected)
        installed = json.loads((self.dest / publisher.MANIFEST).read_text())
        self.assertEqual(installed, self.expected)
        self.assertEqual(set(installed["files"]), set(self.files))


if __name__ == "__main__":
    unittest.main()
