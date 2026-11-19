"""ABR-86 E2: fresh-process, one-command complete Agent Bridge context acceptance.

Only disposable host roots and Git-owned README bytes are read. No provider,
agent launcher, OAuth, private runtime profile or Bridge service is touched.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/agent_context_cli.py"
HANDOFF = ROOT / "scripts/agent-context-handoff.py"
EXPECTED = (
    "host.global-tools", "host.agent-tools", "host.agent-runtimes",
    "repo.agents", "repo.bridge", "repo.jobs",
)
HOST_ROOTS = (
    ("global-tools", "AGENT_CONTEXT_GLOBAL_TOOLS_ROOT", "host.global-tools"),
    ("agent-tools", "AGENT_CONTEXT_AGENT_TOOLS_ROOT", "host.agent-tools"),
    ("agents", "AGENT_CONTEXT_AGENTS_ROOT", "host.agent-runtimes"),
)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


class FreshSessionContextTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="abr86-e2-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.cwd = self.base / "unrelated" / "session"
        self.cwd.mkdir(parents=True)
        self.host_roots = {}
        self.env = os.environ.copy()
        self.env.pop("AGENT_CONTEXT_REPO_ROOT", None)
        self.env["PYTHONUTF8"] = "1"
        for folder, key, doc_id in HOST_ROOTS:
            root = self.base / "private-host-fixture" / folder
            root.mkdir(parents=True)
            source = "templates/context/host-roots/" + folder + "/README.md"
            (root / "README.md").write_bytes(git("show", "HEAD:" + source))
            self.env[key] = str(root)
            self.host_roots[doc_id] = root

    def call(self, *args, tool=CLI, cwd=None):
        # Each call is a NEW isolated Python process; no Python imports or
        # context data are shared across sessions.
        return subprocess.run(
            [sys.executable, "-s", str(tool), *args],
            env=self.env, cwd=cwd or self.cwd, capture_output=True,
            text=True, encoding="utf-8",
        )

    def context(self, *args, cwd=None):
        return self.call("--repo-root", str(ROOT), *args, cwd=cwd)

    def test_one_command_yields_all_six_complete_readmes(self):
        result = self.context("--topic", "jobs", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        bundle = json.loads(result.stdout)
        self.assertEqual(bundle["selection"], {"mode": "topic", "value": "jobs"})
        self.assertEqual(tuple(doc["id"] for doc in bundle["documents"]), EXPECTED)
        self.assertEqual(len(bundle["documents"]), len(set(EXPECTED)))
        self.assertIs(bundle["partial"], False)
        self.assertEqual(bundle["missingDocuments"], [])
        self.assertEqual(bundle["unmatchedPaths"], [])
        self.assertEqual(bundle["gitHeadSha"], git("rev-parse", "HEAD").decode().strip())
        for doc in bundle["documents"]:
            with self.subTest(document=doc["id"]):
                raw = git("show", "HEAD:" + doc["gitSourcePath"])
                self.assertEqual(Path(doc["sourcePath"]).read_bytes(), raw)
                self.assertEqual(doc["content"], raw.decode("utf-8"))
                self.assertEqual(doc["sha256"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(doc["gitHeadSha"], bundle["gitHeadSha"])
                self.assertEqual(doc["gitSha"], git(
                    "log", "-1", "--format=%H", "--", doc["gitSourcePath"]
                ).decode().strip())
                self.assertFalse(doc["worktreeModified"])
                self.assertTrue(doc["reasons"])

    def test_two_fresh_sessions_replay_identical_source_content(self):
        args = ("--repo-root", str(ROOT), "--topic", "jobs", "--format", "json")
        first = self.call(*args)
        second = self.call(*args, cwd=self.base)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        # --repo-root must win over an unrelated parent or inherited override.
        self.env["AGENT_CONTEXT_REPO_ROOT"] = str(self.base)
        overridden = self.call(*args)
        self.assertEqual(overridden.returncode, 0, overridden.stderr)
        self.assertEqual(overridden.stdout, first.stdout)

    def test_lifecycle_alias_includes_same_six_sources(self):
        result = self.context("--topic", "lifecycle", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            tuple(doc["id"] for doc in json.loads(result.stdout)["documents"]), EXPECTED
        )

    def test_unavailable_host_doc_fails_closed_without_partial_opt_in(self):
        (self.host_roots["host.agent-tools"] / "README.md").unlink()
        result = self.context("--topic", "jobs", "--format", "json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Context source missing", result.stderr)
        self.assertEqual(result.stdout, "")

        partial = self.context(
            "--topic", "jobs", "--format", "json", "--allow-partial"
        )
        self.assertEqual(partial.returncode, 0, partial.stderr)
        data = json.loads(partial.stdout)
        self.assertTrue(data["partial"])
        self.assertEqual(
            [item["id"] for item in data["missingDocuments"]], ["host.agent-tools"]
        )
        self.assertEqual(
            tuple(doc["id"] for doc in data["documents"]),
            tuple(item for item in EXPECTED if item != "host.agent-tools"),
        )
        self.assertTrue(data["missingDocuments"][0]["reasons"])

    def test_fresh_receiver_can_verify_full_pinned_context_without_host(self):
        message = self.base / "message.txt"
        message.write_text("Review the job lifecycle documentation only.", encoding="utf-8")
        artifact = self.base / "handoff.json"
        create = self.call(
            "create", "--repo-root", str(ROOT),
            "--repository", "REVREBEL/linear-agents", "--topic", "jobs",
            "--message-file", str(message), "--format", "json",
            "--output", str(artifact), tool=HANDOFF,
        )
        self.assertEqual(create.returncode, 0, create.stderr)
        envelope = json.loads(artifact.read_text(encoding="utf-8"))
        self.assertEqual(
            tuple(doc["id"] for doc in envelope["contextBundle"]["documents"]),
            EXPECTED,
        )
        for root in self.host_roots.values():
            shutil.rmtree(root)
        verified = self.call(
            "verify", "--input", str(artifact), "--repo-root", str(ROOT),
            "--check-source", tool=HANDOFF,
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn(envelope["contextSha256"], verified.stdout)


if __name__ == "__main__":
    unittest.main()
