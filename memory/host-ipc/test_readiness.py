"""Self-contained M14 readiness tests."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

P = pathlib.Path(__file__).with_name("readiness.py")
spec = importlib.util.spec_from_file_location("memory_readiness", P)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class Tests(unittest.TestCase):
    def test_readiness_is_read_only_and_never_assumes_canary(self):
        observed = []
        def subprocess_stub(cmd, **kwargs):
            observed.append(cmd)
            class Result:
                returncode = 0
                stdout = ""
            return Result()
        with patch.object(checks, "protected_dir", return_value=True), \
             patch.object(checks, "protected_file", return_value=True), \
             patch.object(checks, "cluster_state", return_value=True), \
             patch.object(checks, "systemd_unit_exists", return_value=True):
            result = checks.audit(run=subprocess_stub)
        self.assertFalse(result["m14Ready"])
        self.assertIn("controlledLiveCanary", result["missing"])

    def test_missing_production_prerequisites_reported_without_changes(self):
        with patch.object(checks, "protected_dir", return_value=False), \
             patch.object(checks, "protected_file", return_value=False), \
             patch.object(checks, "cluster_state", return_value=False), \
             patch.object(checks, "systemd_unit_exists", return_value=False):
            result = checks.audit(run=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("must not call")))
        self.assertFalse(result["m14Ready"])
        self.assertIn("sealedPythonRuntime", result["missing"])
        self.assertIn("scopedPostgresRlsAndRoles", result["missing"])

    def test_unsafe_symlinks_or_ancestor_modes_never_pass(self):
        with patch.object(checks.pathlib.Path, "lstat", side_effect=FileNotFoundError()):
            self.assertFalse(checks.protected_dir("/tmp/not-there"))
            self.assertFalse(checks.protected_file("/tmp/not-there"))
