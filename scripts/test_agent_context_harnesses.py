"""ABR-77 D1: one discoverable skill and actual shared resolver invocation.

Source-level harness tests intentionally do not start interactive model/CLI sessions.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".agents/skills/agent-context/SKILL.md"
HOSTS = (
    ("agents", "AGENT_CONTEXT_AGENTS_ROOT"),
    ("agent-tools", "AGENT_CONTEXT_AGENT_TOOLS_ROOT"),
    ("global-tools", "AGENT_CONTEXT_GLOBAL_TOOLS_ROOT"),
)
EXPECTED = (
    "host.global-tools", "host.agent-tools", "host.agent-runtimes",
    "repo.agents", "repo.bridge",
)


def git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args],
        check=True, capture_output=True,
    ).stdout


class SharedHarnessContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="abr77-harness-")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name).resolve()
        self.env = os.environ.copy()
        self.env.pop("AGENT_CONTEXT_REPO_ROOT", None)
        self.env["PYTHONUTF8"] = "1"
        for folder, name in HOSTS:
            root = self.workspace / "host" / folder
            root.mkdir(parents=True)
            src = f"templates/context/host-roots/{folder}/README.md"
            (root / "README.md").write_bytes(git("show", f"HEAD:{src}"))
            self.env[name] = str(root)

    def invoke(self, *args):
        return subprocess.run(
            [
                sys.executable, str(ROOT / "scripts/agent_context_cli.py"),
                "--repo-root", str(ROOT), *args,
            ],
            cwd=self.workspace, env=self.env,
            capture_output=True, encoding="utf-8", text=True,
        )

    def test_single_canonical_skill_frontmatter_is_valid(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        header, body = text[4:].split("\n---\n", 1)
        metadata = yaml.safe_load(header)
        self.assertEqual(metadata["name"], "agent-context")
        self.assertIn("README", metadata["description"])
        self.assertLessEqual(len(metadata["description"]), 1024)
        self.assertTrue(body.strip())
        self.assertIn("scripts/agent_context_cli.py", body)
        for flag in ("--path", "--topic", "--files-changed", "--format json",
                     "validate", "--allow-partial", "explain"):
            with self.subTest(flag=flag):
                self.assertIn(flag, body)

    def test_project_skill_is_tracked_without_harness_specific_clones(self):
        tracked = git("ls-files", "--", ".agents/skills/agent-context/SKILL.md")
        self.assertEqual(tracked.decode().strip(), ".agents/skills/agent-context/SKILL.md")
        for relative in (
            ".opencode/skills/agent-context/SKILL.md",
            ".codex/skills/agent-context/SKILL.md",
            ".qwen/skills/agent-context/SKILL.md",
            ".vibe/skills/agent-context/SKILL.md",
        ):
            with self.subTest(relative=relative):
                self.assertFalse((ROOT / relative).exists())

    def test_common_and_qwen_persistent_instructions_point_to_same_skill(self):
        common = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        qwen = (ROOT / "QWEN.md").read_text(encoding="utf-8")
        bootstrap = (ROOT / ".agents/README.md").read_text(encoding="utf-8")
        for name, document in (
            ("AGENTS.md", common), ("QWEN.md", qwen),
        ):
            with self.subTest(name=name):
                self.assertIn(".agents/skills/agent-context/SKILL.md", document)
                self.assertIn("scripts/agent_context_cli.py", document)
        self.assertIn("AGENTS.md", qwen)
        self.assertIn("skills/agent-context/SKILL.md", bootstrap)
        self.assertIn("Routing invariants", common)
        self.assertIn("Bridge admission", common)

    def test_harness_discovery_document_has_only_one_resolver_implementation(self):
        guide = (ROOT / "docs/blueprints/agent-context/HARNESSES.md").read_text()
        for name in ("OpenCode", "Codex", "Qwen Code", "Mistral Vibe"):
            with self.subTest(name=name):
                self.assertIn(name, guide)
        self.assertIn(".agents/skills/agent-context/SKILL.md", guide)
        self.assertIn("scripts/agent_context_cli.py", guide)
        self.assertIn("does not", guide.lower())

    def test_every_harness_uses_same_full_strict_json_bundle(self):
        # All four use the same entrypoint/skill; exercise the actual command,
        # rather than pretending a simulated model response tests discovery.
        first = self.invoke("--topic", "profiles", "--format", "json")
        self.assertEqual(first.returncode, 0, first.stderr)
        bundle = json.loads(first.stdout)
        self.assertEqual(tuple(x["id"] for x in bundle["documents"]), EXPECTED)
        self.assertFalse(bundle["partial"])
        self.assertEqual(bundle["missingDocuments"], [])
        for doc in bundle["documents"]:
            expected = git("show", f"HEAD:{doc['gitSourcePath']}")
            self.assertEqual(doc["content"], Path(doc["sourcePath"]).read_text(encoding="utf-8"))
            self.assertEqual(doc["sha256"], hashlib.sha256(expected).hexdigest())
            self.assertEqual(Path(doc["sourcePath"]).read_bytes(), expected)
        second = self.invoke("--topic", "profiles", "--format", "json")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)

    def test_path_scoping_and_explain_use_same_source_documents(self):
        actual = self.invoke("--path", "bridge/orchestration/dispatch.mjs", "--format", "json")
        self.assertEqual(actual.returncode, 0, actual.stderr)
        result = json.loads(actual.stdout)
        self.assertIn("repo.bridge", (d["id"] for d in result["documents"]))
        explanation = self.invoke(
            "explain", "--path", "bridge/orchestration/dispatch.mjs", "--format", "json",
        )
        self.assertEqual(explanation.returncode, 0, explanation.stderr)
        info = json.loads(explanation.stdout)
        self.assertEqual(
            [d["id"] for d in info["documents"]],
            [d["id"] for d in result["documents"]],
        )
        self.assertTrue(all("content" not in d for d in info["documents"]))

    def test_validation_command_is_independent_of_host_profiles(self):
        result = self.invoke("validate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("13 source-backed README contracts", result.stdout)


if __name__ == "__main__":
    unittest.main()
