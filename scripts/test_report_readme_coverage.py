"""ABR-83: Git-backed coverage inventory and local README link regression tests."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/report-readme-coverage.py"
SPEC = importlib.util.spec_from_file_location("readme_coverage", SCRIPT)
reporter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reporter
SPEC.loader.exec_module(reporter)


class ReadmeCoverageTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="abr83-coverage-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.git("init", "-q")
        self.write("README.md", "# Project\n")
        self.write("module/README.md", "# Module\n[Local](sub/tool.py)\n")
        self.write("module/sub/tool.py", "print('behavior')\n")
        self.write("module/sub/data.yaml", "key: value\n")
        self.write("agents/profiles/candidates/model.yaml", "id: candidate\n")
        self.write("docs/guide.md", "# Guide\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    def write(self, name, text):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def commit(self):
        self.git("add", "-A")
        self.git("-c", "user.email=fixture@example.invalid",
                 "-c", "user.name=Coverage Fixture",
                 "commit", "-qm", "reviewed snapshot")

    def run_report(self):
        return reporter.audit(self.root, self.rev)

    def test_every_tracked_directory_is_inventoried(self):
        result = self.run_report()
        self.assertEqual(result["trackedReadmes"], 2)
        self.assertIn("module/sub", [x["directory"] for x in result["uncoveredFolders"]])
        self.assertNotIn("module", [x["directory"] for x in result["uncoveredFolders"]])
        row = next(x for x in result["uncoveredFolders"] if x["directory"] == "module/sub")
        self.assertEqual(row["nearestAncestorReadme"], "module/README.md")
        self.assertEqual(row["behavioralFilesBelow"], 2)

    def test_candidate_only_folder_has_no_behavioral_source(self):
        result = self.run_report()
        row = next(x for x in result["uncoveredFolders"]
                   if x["directory"] == "agents/profiles/candidates")
        self.assertEqual(row["behavioralFilesBelow"], 0)
        self.assertEqual(row["trackedFilesBelow"], 1)

    def test_ancestor_readme_does_not_hide_nested_uncovered_folder(self):
        result = self.run_report()
        self.assertIn("module/sub", [x["directory"] for x in result["uncoveredFolders"]])
        self.assertGreater(result["foldersMissingReadme"], 0)

    def test_valid_local_file_and_directory_links(self):
        self.write("module/README.md",
                   "[Source](sub/tool.py)\n[Directory](sub/)\n[Repo](../README.md)\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        self.assertEqual(self.run_report()["brokenReferenceCount"], 0)

    def test_broken_reference_reports_origin_line_and_target(self):
        self.write("module/README.md", "# Module\n[Missing](sub/gone.py)\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        item = self.run_report()["brokenReferences"][0]
        self.assertEqual((item["document"], item["line"]), ("module/README.md", 2))
        self.assertEqual(item["resolvedPath"], "module/sub/gone.py")
        self.assertEqual(item["reason"], "missing tracked target")

    def test_reference_definitions_and_undefined_labels(self):
        self.write("module/README.md", "[Known][ok]\n[Unknown][missing]\n\n"
                   "[ok]: ../README.md\n[unused]: no-such-file.txt\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        result = self.run_report()
        self.assertEqual(result["brokenReferenceCount"], 2)
        reasons = {x["reason"] for x in result["brokenReferences"]}
        self.assertEqual(reasons, {"undefined Markdown reference", "missing tracked target"})

    def test_external_urls_anchors_and_inline_code_ignored(self):
        self.write("module/README.md", "# Module\n"
                   "[Site](https://example.com/no-file)\n"
                   "[Local heading](#not-validated)\n"
                   "[Website root](/absolute-on-site)\n"
                   "A code example: " + chr(96) + "[bad](missing-code.txt)" + chr(96) + "\n"
                   "~~~md\n[bad](missing-fence.txt)\n~~~\n"
                   "<!-- [bad](missing-comment.md) -->\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        self.assertEqual(self.run_report()["brokenReferenceCount"], 0)

    def test_html_and_encoded_local_references(self):
        self.write("module/sub/space name.md", "# Space\n")
        self.write("module/README.md",
                   '<a href="sub/space%20name.md">okay</a>\n'
                   '<img src="sub/gone.svg">\n')
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        result = self.run_report()
        self.assertEqual(result["brokenReferenceCount"], 1)
        self.assertEqual(result["brokenReferences"][0]["kind"], "html-link")

    def test_escape_from_repo_is_reported(self):
        self.write("module/README.md", "[Wrong](../../outside.md)\n")
        self.commit()
        self.rev = self.git("rev-parse", "HEAD")
        result = self.run_report()
        self.assertEqual(result["brokenReferences"][0]["reason"], "link escapes Git root")

    def test_dirty_local_readme_does_not_change_reviewed_snapshot(self):
        initial = self.run_report()
        self.write("module/README.md", "[Untracked local issue](gone.md)\n")
        self.write("module/private.txt", "untracked bytes")
        self.assertEqual(self.run_report(), initial)

    def test_json_and_markdown_are_stable_and_machine_readable(self):
        report = self.run_report()
        self.assertEqual(report, self.run_report())
        rendered = reporter.markdown(report)
        self.assertIn("# README coverage", rendered)
        self.assertIn("Directories without", rendered)
        self.assertEqual(json.loads(json.dumps(report, sort_keys=True)), report)
        self.assertEqual(len(report["sourceCommit"]), 40)

    def test_cli_writes_both_format_artifacts(self):
        for fmt in ("json", "markdown"):
            with self.subTest(fmt=fmt):
                output = self.root / ("report." + fmt)
                cmd = [
                    sys.executable, str(SCRIPT), "--repo", str(self.root),
                    "--ref", self.rev, "--format", fmt, "--output", str(output),
                ]
                result = subprocess.run(cmd, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(output.is_file())
                if fmt == "json":
                    self.assertEqual(json.loads(output.read_text()), self.run_report())
                else:
                    self.assertIn("Git commit:", output.read_text())

    def test_unknown_revision_exits_without_report(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.root),
             "--ref", "missing-sha", "--format", "json"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("could not run", result.stderr)

    def test_scoped_document_sources(self):
        paths = [
            "README.md", "AGENTS.md", "QWEN.md", "docs/blueprints/agent-context/A.md",
            "docs/unrelated/guide.md", "module/README.md", "module/thing.py",
        ]
        self.assertEqual(
            reporter.documents(paths),
            ["AGENTS.md", "QWEN.md", "README.md",
             "docs/blueprints/agent-context/A.md", "module/README.md"],
        )


if __name__ == "__main__":
    unittest.main()
