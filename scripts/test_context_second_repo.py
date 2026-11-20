"""ABR-88 E4: independent TypeScript/Next.js repository portability acceptance.

The fixture creates an actual, independent Git coding checkout from portable
templates; it does not copy Agent Bridge's registry, manifest or host READMEs.
No live application files, servers, credentials or package installs are touched.
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
SAMPLE = ROOT / "templates/context/examples/nextjs-app"
SCHEMAS = ("context-frontmatter.schema.json", "context-manifest.schema.json")
MODULES = ("agent_context_cli.py", "context_contract.py", "context_resolver.py",
           "agent-context-handoff.py")
EXPECTED_COLLECTIONS = (
    "host.toolchain", "host.design-system", "repo.application", "repo.collections",
)
EXPECTED_APPLICATION = EXPECTED_COLLECTIONS[:-1]
HOSTS = (
    ("host-ui", "INDEPENDENT_CONTEXT_UI_ROOT", "design-system", "host.design-system"),
    ("host-tools", "INDEPENDENT_CONTEXT_TOOLS_ROOT", "toolchain", "host.toolchain"),
)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


class IndependentCodingRepoTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="abr88-nextjs-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.repo = self.base / "independent-nextjs-app"
        self.repo.mkdir()
        # Only example sources and portable implementation are copied.
        # A separate commit establishes genuinely independent Git provenance.
        for source in sorted(SAMPLE.rglob("*")):
            if source.is_file():
                rel = source.relative_to(SAMPLE)
                target = self.repo / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        for name in SCHEMAS:
            src = ROOT / "templates/context" / name
            dest = self.repo / "templates/context" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
        for name in MODULES:
            dest = self.repo / "scripts" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "scripts" / name, dest)
        (self.repo / ".gitattributes").write_text(
            "*.md text eol=lf\n*.yaml text eol=lf\n*.py text eol=lf\n", encoding="utf-8")
        (self.repo / ".gitignore").write_text(
            "__pycache__/\n*.py[cod]\n", encoding="utf-8")
        (self.repo / "package.json").write_text(
            '{"name":"independent-cms","private":true,"type":"module"}\n',
            encoding="utf-8")
        (self.repo / "README.md").write_text("# Independent coding repository\n")
        (self.repo / "src/app").mkdir(parents=True, exist_ok=True)
        (self.repo / "src/app/page.tsx").write_text(
            "export default function Page() { return <main>CMS app</main>; }\n",
            encoding="utf-8")
        (self.repo / "src/collections/Users.ts").write_text(
            "export const Users = { slug: 'users' } as const;\n",
            encoding="utf-8")
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run([
            "git", "-C", str(self.repo), "-c", "user.name=Context Pilot",
            "-c", "user.email=pilot@example.invalid", "commit", "-qm", "Independent app"
        ], check=True)
        self.env = os.environ.copy()
        self.env["PYTHONUTF8"] = "1"
        self.env.pop("AGENT_CONTEXT_REPO_ROOT", None)
        self.cwd = self.repo / "src/app"
        self.hosts = {}
        for _, key, folder, id_ in HOSTS:
            directory = self.base / "external-roots" / folder
            directory.mkdir(parents=True)
            source = self.repo / "templates/context/host-roots" / folder / "README.md"
            shutil.copyfile(source, directory / "README.md")
            self.env[key] = str(directory)
            self.hosts[id_] = directory

    def invoke(self, *args, script="agent_context_cli.py", cwd=None):
        return subprocess.run(
            [sys.executable, "-s", str(self.repo / "scripts" / script), *args],
            cwd=cwd or self.cwd, env=self.env,
            capture_output=True, text=True, encoding="utf-8",
        )

    def bundle(self, *args, **options):
        result = self.invoke(*args, **options)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_second_repo_owns_independent_manifest_without_bridge_paths(self):
        result = self.invoke("validate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("5 source-backed README contracts", result.stdout)
        manifest = (self.repo / ".agents/context.yaml").read_text()
        self.assertIn("project: independent-nextjs-cms", manifest)
        self.assertNotIn("agent-bridge", manifest)
        self.assertNotIn("repo.bridge", manifest)
        self.assertNotIn("host.agent-runtimes", manifest)
        self.assertTrue((self.repo / "src/collections/Users.ts").is_file())

    def test_custom_host_roots_resolve_complete_source_linked_context(self):
        bundle = self.bundle("--topic", "collections", "--format", "json")
        self.assertEqual(bundle["project"], "independent-nextjs-cms")
        self.assertEqual(tuple(item["id"] for item in bundle["documents"]),
                         EXPECTED_COLLECTIONS)
        self.assertEqual(bundle["selection"], {"mode": "topic", "value": "collections"})
        self.assertEqual(bundle["missingDocuments"], [])
        self.assertFalse(bundle["partial"])
        self.assertEqual(bundle["gitHeadSha"], git(self.repo, "rev-parse", "HEAD").decode().strip())
        for item in bundle["documents"]:
            with self.subTest(id=item["id"]):
                blob = git(self.repo, "show", "HEAD:" + item["gitSourcePath"])
                self.assertEqual(item["content"].encode(), blob)
                self.assertEqual(Path(item["sourcePath"]).read_bytes(), blob)
                self.assertEqual(item["sha256"], hashlib.sha256(blob).hexdigest())
                self.assertFalse(item["worktreeModified"])
                self.assertTrue(item["reasons"])
                self.assertEqual(item["gitSha"], git(
                    self.repo, "log", "-1", "--format=%H", "--",
                    item["gitSourcePath"]).decode().strip())
        self.assertEqual(
            bundle["documents"][0]["gitSourcePath"],
            "templates/context/host-roots/toolchain/README.md",
        )

    def test_path_selection_uses_nearest_nextjs_collection_owner(self):
        scoped = self.bundle("--path", "src/collections/Users.ts", "--format", "json")
        self.assertEqual(tuple(v["id"] for v in scoped["documents"]),
                         EXPECTED_COLLECTIONS)
        self.assertIn("path: src/collections/Users.ts",
                      scoped["documents"][-1]["reasons"])
        app = self.bundle("--path", "src/app/page.tsx", "--format", "json")
        self.assertEqual(tuple(v["id"] for v in app["documents"]),
                         EXPECTED_APPLICATION)

    def test_root_discovery_and_independent_invocations_are_deterministic(self):
        args = ("--topic", "collections", "--format", "json")
        one = self.invoke(*args)
        two = self.invoke(*args, cwd=self.repo)
        self.assertEqual(one.returncode, 0, one.stderr)
        self.assertEqual(one.stdout, two.stdout)
        self.env["AGENT_CONTEXT_REPO_ROOT"] = str(ROOT)
        explicit = self.invoke("--repo-root", str(self.repo), *args)
        self.assertEqual(explicit.returncode, 0, explicit.stderr)
        self.assertEqual(explicit.stdout, one.stdout)

    def test_default_selector_uses_portable_bootstrap_and_host_dependency(self):
        result = self.bundle("--format", "json")
        self.assertEqual(tuple(v["id"] for v in result["documents"]),
                         (*EXPECTED_APPLICATION, "repo.bootstrap"))
        self.assertEqual(result["selection"],
                         {"mode": "default", "value": "repo.bootstrap"})

    def test_changed_files_match_second_repository_not_bridge(self):
        target = self.repo / "src/collections/Users.ts"
        target.write_text(target.read_text() + "export const version = 2;\n")
        bundle = self.bundle("--files-changed", "--format", "json")
        self.assertEqual(tuple(v["id"] for v in bundle["documents"]),
                         EXPECTED_COLLECTIONS)
        self.assertEqual(bundle["selection"]["value"], ["src/collections/Users.ts"])
        self.assertEqual(bundle["unmatchedPaths"], [])
        self.assertFalse(any(doc["worktreeModified"] for doc in bundle["documents"]))

    def test_missing_host_requires_explicit_partial_and_never_discards_available_docs(self):
        (self.hosts["host.design-system"] / "README.md").unlink()
        result = self.invoke("--topic", "collections", "--format", "json")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Context source missing", result.stderr)
        partial = self.bundle("--topic", "collections", "--allow-partial", "--format", "json")
        self.assertTrue(partial["partial"])
        self.assertEqual([d["id"] for d in partial["missingDocuments"]],
                         ["host.design-system"])
        self.assertEqual(tuple(d["id"] for d in partial["documents"]),
                         tuple(d for d in EXPECTED_COLLECTIONS if d != "host.design-system"))
        self.assertIn("required by: repo.application",
                      partial["missingDocuments"][0]["reasons"])

    def test_host_drift_fails_even_with_partial_opt_in(self):
        target = self.hosts["host.design-system"] / "README.md"
        target.write_text(target.read_text() + "\nUnreviewed host mutation\n")
        for flags in ((), ("--allow-partial",)):
            with self.subTest(flags=flags):
                failure = self.invoke("--topic", "collections", *flags)
                self.assertNotEqual(failure.returncode, 0)
                self.assertIn("differs from reviewed Git source", failure.stderr)

    def test_custom_git_source_path_rejects_escape_and_id_spoofing(self):
        manifest = self.repo / ".agents/context.yaml"
        original = manifest.read_text()
        replaced = original.replace(
            "source: templates/context/host-roots/design-system/README.md",
            "source: ../outside/README.md")
        self.assertNotEqual(replaced, original)
        manifest.write_text(replaced)
        failure = self.invoke("validate")
        self.assertNotEqual(failure.returncode, 0)
        self.assertIn("Unsafe relative context document path", failure.stderr)
        manifest.write_text(original)
        reference = self.repo / "templates/context/host-roots/design-system/README.md"
        reference.write_text(reference.read_text().replace(
            "id: host.design-system", "id: host.different"))
        failure = self.invoke("validate")
        self.assertNotEqual(failure.returncode, 0)
        self.assertIn("Context README ID mismatch", failure.stderr)

    def test_reproducible_handoff_verifies_after_host_roots_are_removed(self):
        message = self.base / "message.md"
        message.write_text("Review the Payload collection model; do not deploy.")
        artifact = self.base / "handoff.json"
        created = self.invoke(
            "create", "--repo-root", str(self.repo),
            "--repository", "REVREBEL/independent-nextjs-pilot",
            "--message-file", str(message), "--topic", "collections",
            "--format", "json", "--output", str(artifact),
            script="agent-context-handoff.py",
        )
        self.assertEqual(created.returncode, 0, created.stderr)
        envelope = json.loads(artifact.read_text())
        self.assertEqual(envelope["repository"], "REVREBEL/independent-nextjs-pilot")
        self.assertEqual(tuple(x["id"] for x in envelope["contextBundle"]["documents"]),
                         EXPECTED_COLLECTIONS)
        for directory in self.hosts.values():
            shutil.rmtree(directory)
        verified = self.invoke(
            "verify", "--input", str(artifact), "--repo-root", str(self.repo),
            "--check-source", script="agent-context-handoff.py",
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn(envelope["contextSha256"], verified.stdout)


if __name__ == "__main__":
    unittest.main()
