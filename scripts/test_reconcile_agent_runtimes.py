"""Offline regression tests for the non-dispatching host inventory reconciler."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).with_name("reconcile-agent-runtimes.py")
spec = importlib.util.spec_from_file_location("agent_runtime_reconcile", MODULE_PATH)
reconcile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reconcile)


class HostRuntimeInventoryTests(unittest.TestCase):
    def setUp(self):
        self.source = reconcile.read_json(reconcile.SOURCE)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "agent-runtimes.json"
        self.target.write_text(json.dumps(self.source, indent=2) + "\n", encoding="utf-8")

    def test_git_source_stays_disabled_and_uses_actual_tool_roots(self):
        reconcile.validate(self.source)
        self.assertEqual(self.source["defaultNodeHome"], "/opt/global-tools/volta")
        self.assertEqual(set(self.source["agents"]), reconcile.HARNESS_NAMES)
        self.assertEqual(self.source["agents"]["codex"]["kind"], "volta")
        self.assertTrue(all(not item["enabledForDispatch"] for item in self.source["agents"].values()))

    def test_exact_snapshot_matches_and_drift_is_reported(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(reconcile.check(self.target, self.source), 0)
        old = reconcile.read_json(self.target)
        old["defaultNodeHome"] = "/opt/volta"
        self.target.write_text(json.dumps(old), encoding="utf-8")
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertEqual(reconcile.check(self.target, self.source), 1)
        self.assertIn("defaultNodeHome", errors.getvalue())

    def test_apply_backs_up_and_preserves_target_mode(self):
        old = reconcile.read_json(self.target)
        old["agents"]["codex"]["command"] = None
        old["agents"]["codex"]["kind"] = "not-installed"
        self.target.write_text(json.dumps(old), encoding="utf-8")
        self.target.chmod(0o640)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(reconcile.install(self.target, self.source), 0)
        self.assertEqual(reconcile.read_json(self.target), self.source)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        backups = list(self.target.parent.glob("agent-runtimes.json.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(reconcile.read_json(backups[0]), old)

    def test_apply_preserves_group_or_refuses_before_replacement(self):
        old = reconcile.read_json(self.target)
        old["defaultNodeHome"] = "/opt/volta"
        self.target.write_text(json.dumps(old), encoding="utf-8")
        actual_stat = Path.stat
        target_stat = actual_stat(self.target)
        simulated = mock.Mock(wraps=target_stat)
        simulated.st_mode = target_stat.st_mode
        simulated.st_uid = target_stat.st_uid
        simulated.st_gid = target_stat.st_gid + 10000
        def fake_stat(path, *args, **kwargs):
            return simulated if path == self.target else actual_stat(path, *args, **kwargs)
        with mock.patch.object(Path, "stat", fake_stat), \
             mock.patch.object(reconcile.os, "chown", side_effect=PermissionError("group denied")):
            with self.assertRaises(PermissionError):
                reconcile.install(self.target, self.source)
        self.assertEqual(reconcile.read_json(self.target), old)

    def test_refuses_to_replace_dispatch_enabled_target(self):
        old = reconcile.read_json(self.target)
        old["agents"]["gemini"]["enabledForDispatch"] = True
        self.target.write_text(json.dumps(old), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "enabled dispatch"):
            reconcile.install(self.target, self.source)
        self.assertEqual(list(self.target.parent.glob("*.backup-*")), [])

    def test_refuses_active_source_and_invalid_paths(self):
        changed = json.loads(json.dumps(self.source))
        changed["agents"]["kilo"]["enabledForDispatch"] = True
        with self.assertRaisesRegex(ValueError, "never enable dispatch"):
            reconcile.validate(changed)
        changed = json.loads(json.dumps(self.source))
        changed["agents"]["codex"]["command"] = "/opt/volta/bin/codex"
        with self.assertRaisesRegex(ValueError, "approved Volta shim"):
            reconcile.validate(changed)

    def test_target_symlink_is_rejected(self):
        linked = Path(self.temp.name) / "symlink"
        linked.symlink_to(self.target)
        with self.assertRaisesRegex(ValueError, "regular staged inventory"):
            reconcile.check(linked, self.source)


if __name__ == "__main__":
    unittest.main()
