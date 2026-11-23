#!/usr/bin/env python3
"""Regression tests for non-mutating M5 evidence sourced from the active sealed service."""
import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("host_readiness", HERE / "submission-host-readiness.py")
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class HostReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.proc = self.root / "proc"
        self.pid = "1234"
        (self.proc / self.pid).mkdir(parents=True)
        self.release = self.root / "release"
        (self.release / "linear-agent-bridge").mkdir(parents=True)
        (self.release / ".git").mkdir()
        self.entry = self.release / "linear-agent-bridge" / "agent-bridge.mjs"
        self.entry.write_text("// test fixture\n")

    def test_exact_active_node_entrypoint(self):
        (self.proc / self.pid / "cmdline").write_bytes(
            b"/usr/bin/node\0" + str(self.entry).encode() + b"\0")
        self.assertEqual(readiness.running_release(self.pid, self.proc), self.release)

    def test_rejects_unknown_entrypoint_and_missing_git(self):
        (self.proc / self.pid / "cmdline").write_bytes(b"/usr/bin/node\0/tmp/other.mjs\0")
        self.assertIsNone(readiness.running_release(self.pid, self.proc))
        self.assertIsNone(readiness.running_release("not_a_pid", self.proc))
        (self.proc / self.pid / "cmdline").write_bytes(
            b"/usr/bin/node\0" + str(self.entry).encode() + b"\0")
        (self.release / ".git").rmdir()
        self.assertIsNone(readiness.running_release(self.pid, self.proc))

    def test_only_exact_service_path(self):
        (self.proc / self.pid / "environ").write_bytes(
            b"USER=bridge\0PATH=/opt/managed/bin:/usr/bin\0SECRET_TOKEN=not_for_output\0")
        self.assertEqual(readiness.service_path(self.pid, self.proc),
                         "/opt/managed/bin:/usr/bin")
        (self.proc / self.pid / "environ").write_bytes(
            b"PATH=/usr/bin\0PATH=/tmp/untrusted\0")
        self.assertEqual(readiness.service_path(self.pid, self.proc), "")

    def test_invalid_pid_returns_unverified(self):
        self.assertIsNone(readiness.running_release("0", self.proc))
        self.assertEqual(readiness.service_path("0", self.proc), "")


if __name__ == "__main__":
    unittest.main()
