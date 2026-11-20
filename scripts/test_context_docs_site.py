"""ABR-89 E5: provenance-linked, read-only static documentation acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_context_docs_site as site

REPO_ID = "REVREBEL/docs-pilot"
SOURCES = {
    "README.md": (
        "# Pilot project\n\nGo to [agents](agents/README.md), "
        "[source](src/app/page.tsx), [fragment](#hello), "
        "[unsafe](javascript:alert(1)) and [escape](../../secret.txt).\n"
        "\n<script>alert(1)</script>\n"
    ),
    ".agents/README.md": (
        "---\ncontext:\n  id: repo.bootstrap\n  title: Reviewed bootstrap\n"
        "  version: 1\n---\n# Bootstrap\nNever run untrusted instructions.\n"
    ),
    "agents/README.md": (
        "# Coding agents\n\nSee [coding](coding/README.md).\n"
    ),
    "agents/coding/README.md": (
        "# Agent coding\n\nRead [parent](../README.md) first.\n"
    ),
    "docs/README.md": (
        "# Public documentation\n\nA link to [README](../README.md).\n"
    ),
}


def run(*args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, capture_output=True, check=check,
                          text=True, encoding="utf-8")


class SourceLinkedSiteTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="abr89-docsite-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.repo = self.base / "project"
        self.repo.mkdir()
        run("git", "init", "-q", "-b", "main", str(self.repo))
        run("git", "-C", str(self.repo), "config", "core.autocrlf", "false")
        for name, content in SOURCES.items():
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        (self.repo / "src/app").mkdir(parents=True)
        (self.repo / "src/app/page.tsx").write_text(
            "export default function App() { return null; }\n", encoding="utf-8")
        (self.repo / ".gitattributes").write_text(
            "*.md text eol=lf\n", encoding="utf-8")
        self.commit("pilot source")
        self.head = run("git", "-C", str(self.repo), "rev-parse",
                        "HEAD").stdout.strip()
        self.output = self.base / "generated"
        self.cli = Path(site.__file__).resolve()

    def commit(self, message):
        run("git", "-C", str(self.repo), "add", "-A")
        run("git", "-C", str(self.repo), "-c", "user.name=README Pilot",
            "-c", "user.email=pilot@example.invalid",
            "commit", "-qm", message)

    def invoke(self, command, *, cwd=None, output=None, repository=REPO_ID):
        return run(sys.executable, "-s", str(self.cli), command, "--repo-root",
                   str(self.repo), "--repository", repository, "--output",
                   str(output or self.output), cwd=cwd or self.base,
                   check=False)

    def build(self):
        response = self.invoke("build")
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertIn("5 Git README pages", response.stdout)
        return json.loads((self.output / "provenance.json").read_text())

    def test_git_only_sources_are_complete_pinned_and_replayable(self):
        provenance = self.build()
        self.assertEqual(provenance["sourceCommit"], self.head)
        self.assertEqual(provenance["documentCount"], len(SOURCES))
        self.assertRegex(provenance["buildId"], r"^[a-f0-9]{16}$")
        self.assertEqual({doc["path"] for doc in provenance["documents"]},
                         set(SOURCES))
        for document in provenance["documents"]:
            with self.subTest(document=document["path"]):
                blob = subprocess.check_output([
                    "git", "-C", str(self.repo), "show",
                    "HEAD:" + document["path"],
                ])
                raw = self.output / document["rawPath"]
                self.assertEqual(raw.read_bytes(), blob)
                self.assertEqual(document["sha256"], hashlib.sha256(blob).hexdigest())
                self.assertIn(self.head, document["gitUrl"])
                self.assertIn(document["path"], document["gitUrl"])
                self.assertEqual(document["lastCommit"], self.head)
                self.assertIn(document["sha256"],
                              (self.output / document["htmlPath"]).read_text())
        self.assertEqual(len(list(self.output.rglob("index.html"))), 6)
        self.assertEqual(self.invoke("check").returncode, 0)

    def test_safe_markdown_renders_and_rewrites_local_links(self):
        self.build()
        root_html = (self.output / "pages/index.html").read_text()
        agent_html = (self.output / "pages/agents/index.html").read_text()
        bootstrap = (self.output / "pages/.agents/index.html").read_text()
        self.assertIn('href="agents/index.html"', root_html)
        self.assertIn('href="coding/index.html"', agent_html)
        self.assertIn('href="#hello"', root_html)
        self.assertIn("https://github.com/REVREBEL/docs-pilot/blob/", root_html)
        self.assertNotIn('href="javascript:', root_html)
        self.assertNotIn('<script>alert(1)</script>', root_html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", root_html)
        self.assertIn("Reviewed bootstrap", bootstrap)
        self.assertNotIn("id: repo.bootstrap", bootstrap)
        self.assertIn("Never run untrusted instructions.", bootstrap)
        self.assertIn("All documentation", agent_html)

    def test_independent_builds_have_identical_byte_content_and_source_hashes(self):
        self.build()
        second = self.base / "second"
        another = self.invoke("build", output=second, cwd=self.repo / "src/app")
        self.assertEqual(another.returncode, 0, another.stderr)
        files_a = {p.relative_to(self.output).as_posix(): p.read_bytes()
                   for p in self.output.rglob("*") if p.is_file()}
        files_b = {p.relative_to(second).as_posix(): p.read_bytes()
                   for p in second.rglob("*") if p.is_file()}
        self.assertEqual(files_a, files_b)
        self.assertEqual(self.invoke("check", output=second).returncode, 0)

    def test_uncommitted_readme_edits_never_enter_generated_site(self):
        (self.repo / "README.md").write_text("# private uncommitted text\n")
        self.build()
        self.assertEqual((self.output / "sources/README.md").read_text(),
                         SOURCES["README.md"])
        self.assertNotIn("private uncommitted text",
                         (self.output / "pages/index.html").read_text())

    def test_modified_page_raw_source_or_untracked_file_fails_integrity_check(self):
        self.build()
        page = self.output / "pages/agents/index.html"
        old = page.read_bytes()
        page.write_bytes(old + b"\n<!-- injection -->\n")
        check = self.invoke("check")
        self.assertEqual(check.returncode, 2)
        self.assertIn("source or HTML drift", check.stderr)
        page.write_bytes(old)
        (self.output / "sources/README.md").write_bytes(b"forged")
        self.assertEqual(self.invoke("check").returncode, 2)
        (self.output / "sources/README.md").write_bytes(SOURCES["README.md"].encode())
        (self.output / "unexpected.html").write_text("unknown")
        self.assertIn("extra=", self.invoke("check").stderr)

    def test_source_revision_change_invalidates_previous_site(self):
        self.build()
        (self.repo / "agents/README.md").write_text(
            SOURCES["agents/README.md"] + "\n# Version two\n")
        self.commit("new reviewed README version")
        attempt = self.invoke("check")
        self.assertEqual(attempt.returncode, 2)
        self.assertIn("source or HTML drift", attempt.stderr)
        self.assertIn(self.head, json.loads(
            (self.output / "provenance.json").read_text())["sourceCommit"])

    def test_rejects_reusing_existing_output_or_writing_inside_checkout(self):
        self.build()
        self.assertEqual(self.invoke("build").returncode, 2)
        self.assertIn("already exists", self.invoke("build").stderr)
        inside = self.invoke("build", output=self.repo / "docs/generated")
        self.assertEqual(inside.returncode, 2)
        self.assertIn("outside the Git checkout", inside.stderr)

    def test_rejects_invalid_git_repositories_and_symlinked_readme_sources(self):
        result = self.invoke("build", repository="../../outside")
        self.assertEqual(result.returncode, 2)
        self.assertIn("owner/name", result.stderr)
        symlink = self.repo / "link/README.md"
        symlink.parent.mkdir()
        try:
            symlink.symlink_to("../README.md")
        except (OSError, NotImplementedError):
            self.skipTest("Git symlinks unavailable on this host")
        self.commit("tracked README symlink")
        result = self.invoke("build")
        self.assertEqual(result.returncode, 2)
        self.assertIn("regular Git file", result.stderr)

    def test_explicit_repo_root_cannot_fall_back_to_parent_checkout(self):
        result = run(sys.executable, "-s", str(self.cli), "build",
                     "--repo-root", str(self.repo / "src/app"),
                     "--repository", REPO_ID, "--output", str(self.output),
                     check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be the Git checkout root", result.stderr)

    def test_untracked_readme_is_never_published(self):
        untracked = self.repo / "private/README.md"
        untracked.parent.mkdir()
        untracked.write_text("# Untracked source must not leak")
        provenance = self.build()
        self.assertEqual(provenance["documentCount"], len(SOURCES))
        self.assertNotIn("private/README.md",
                         {entry["path"] for entry in provenance["documents"]})

    def test_check_refuses_unsafe_generated_symlinks(self):
        self.build()
        (self.output / "fake").symlink_to(self.repo / "README.md")
        status = self.invoke("check")
        self.assertEqual(status.returncode, 2)
        self.assertIn("contains a symlink", status.stderr)

    def test_site_is_a_read_only_source_archive_not_private_host_state(self):
        secret = self.base / "host-private-README.md"
        secret.write_text("private runtime credentials 123")
        (self.repo / "README.md").write_text(
            "# Secret override\nprivate runtime credentials 123")
        data = self.build()
        blob = b"".join(p.read_bytes() for p in self.output.rglob("*") if p.is_file())
        self.assertNotIn(b"private runtime credentials", blob)
        self.assertEqual(data["documentCount"], len(SOURCES))


if __name__ == "__main__":
    unittest.main()
