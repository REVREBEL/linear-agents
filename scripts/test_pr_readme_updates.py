"""ABR-79: behavioral PRs update physically nearest tracked README."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "check-pr-readme-updates.py"
SPEC = importlib.util.spec_from_file_location("pr_readme_discipline", SCRIPT)
policy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = policy
SPEC.loader.exec_module(policy)


class PrReadmeDisciplineTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="abr79-pr-readmes-")
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        self.git("init", "-q", "-b", "main")
        self.write("README.md", "# Root README\n")
        for directory in (
            "jobs", "jobs/admission", "integrations",
            "integrations/litellm", "agents",
            "agents/profiles/candidates", "scripts", "memory",
            "memory/migrations", "bridge", ".agents",
        ):
            self.write(f"{directory}/README.md", "# Owning README\n")
        for source in (
            "jobs/admission/handler.mjs",
            "integrations/litellm/runtime.mjs",
            "agents/registry.json", "scripts/utility.py",
            "memory/migrations/001.sql", "bridge/server/runner.mjs",
            "package.json",
        ):
            self.write(source, "original content\n")
        self.commit("baseline")
        self.base = self.rev()

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

    def rev(self):
        return self.git("rev-parse", "HEAD")

    def write(self, name, value):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding="utf-8")

    def update(self, name, value="\nBehavior updated.\n"):
        target = self.repo / name
        self.write(name, target.read_text(encoding="utf-8") + value)

    def commit(self, label="change"):
        self.git("add", "-A")
        self.git("-c", "user.email=fixture@example.invalid",
                 "-c", "user.name=Fixture", "commit", "-qm", label)

    def check(self):
        self.commit()
        return policy.check_pr(self.repo, self.base, self.rev())

    def test_nested_owner_required_not_ancestor(self):
        self.update("jobs/admission/handler.mjs")
        self.update("jobs/README.md")
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual(report["missing"][0]["readme"], "jobs/admission/README.md")

    def test_same_pr_nested_owner_update_passes(self):
        self.update("jobs/admission/handler.mjs")
        self.update("jobs/admission/README.md")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertEqual(report["covered"][0]["readme"], "jobs/admission/README.md")

    def test_two_independent_owners_both_required(self):
        self.update("jobs/admission/handler.mjs")
        self.update("integrations/litellm/runtime.mjs")
        self.update("jobs/admission/README.md")
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual([x["readme"] for x in report["missing"]],
                         ["integrations/litellm/README.md"])

    def test_schema_and_configuration_change_are_behavioral(self):
        self.update("agents/registry.json")
        self.update("agents/README.md")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertIn("agents/registry.json", [x["path"] for x in report["covered"]])

    def test_migration_requires_nested_migration_readme(self):
        self.update("memory/migrations/001.sql")
        report = self.check()
        self.assertEqual(report["missing"][0]["readme"],
                         "memory/migrations/README.md")

    def test_research_candidate_and_catalog_data_automatically_exempt(self):
        self.write("agents/profiles/candidates/beam.yaml", "id: beam\n")
        self.write("agents/profiles/research/local.yaml", "id: local\n")
        self.write("agents/agent-registry.yaml", "agents: []\n")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["exemptions"]), 3)
        self.assertTrue(all("research candidate/catalog data" in x["reason"]
                            for x in report["exemptions"]))

    def test_profile_exemption_does_not_mask_behavior_change(self):
        self.write("agents/profiles/candidates/beam.yaml", "id: beam\n")
        self.update("agents/registry.json")
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual(report["missing"][0]["readme"], "agents/README.md")
        self.assertEqual(len(report["exemptions"]), 1)

    def test_test_and_docs_only_changes_are_explicitly_exempt(self):
        self.write("jobs/admission/handler.test.mjs", "import test from 'node:test';\n")
        self.write("scripts/test_utility.py", "def test_a(): pass\n")
        self.write("docs/guide.md", "# Guide\n")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertFalse(report["missing"])
        self.assertEqual(len(report["exemptions"]), 3)

    def test_skill_instruction_change_uses_agents_bootstrap_readme(self):
        self.write(".agents/skills/agent-context/SKILL.md", "---\nname: agent-context\n---\n")
        report = self.check()
        self.assertEqual(report["missing"][0]["readme"], ".agents/README.md")

    def test_root_level_behavior_uses_root_readme(self):
        self.update("package.json")
        self.update("README.md")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertIn("README.md", [x["readme"] for x in report["covered"]])

    def test_unowned_nested_source_reported_for_d4_not_blocked(self):
        self.write("unmapped/pkg/runtime.mjs", "export const x = 1;\n")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertEqual(report["unowned"][0]["path"], "unmapped/pkg/runtime.mjs")

    def test_rename_between_owners_requires_both_readmes(self):
        self.git("mv", "jobs/admission/handler.mjs", "integrations/litellm/handler.mjs")
        self.update("integrations/litellm/README.md")
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual([x["readme"] for x in report["missing"]],
                         ["jobs/admission/README.md"])

    def test_deletion_is_behavioral_and_requires_updated_owner(self):
        (self.repo / "bridge/server/runner.mjs").unlink()
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual(report["missing"][0]["readme"], "bridge/README.md")

    def test_deleted_owner_readme_is_not_valid_documentation_update(self):
        (self.repo / "jobs/admission/README.md").unlink()
        self.update("jobs/admission/handler.mjs")
        report = self.check()
        self.assertFalse(report["passed"])
        self.assertEqual(report["missing"][0]["readme"], "jobs/admission/README.md")

    def test_new_module_with_new_readme_passes(self):
        self.write("integrations/new-adapter/agent.ts", "export const a = 1;\n")
        self.write("integrations/new-adapter/README.md", "# Adapter\n")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertEqual(report["covered"][0]["readme"],
                         "integrations/new-adapter/README.md")

    def test_untracked_working_tree_edits_do_not_affect_pr_report(self):
        self.update("bridge/server/runner.mjs")
        self.update("bridge/README.md")
        self.commit()
        head = self.rev()
        self.update("jobs/admission/handler.mjs")
        report = policy.check_pr(self.repo, self.base, head)
        self.assertTrue(report["passed"])
        self.assertNotIn("jobs/admission/handler.mjs",
                         [item["path"] for item in report["covered"]])

    def test_effective_diff_ignores_unrelated_new_base_commits(self):
        self.git("checkout", "-q", "-b", "feature")
        self.update("jobs/admission/handler.mjs")
        self.update("jobs/admission/README.md")
        self.commit("feature")
        head = self.rev()
        self.git("checkout", "-q", "main")
        self.update("bridge/server/runner.mjs")
        self.commit("later base")
        report = policy.check_pr(self.repo, self.rev(), head)
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["covered"]), 1)

    def test_bad_git_base_or_head_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Git diff cannot be verified"):
            policy.check_pr(self.repo, "not-a-real-commit", self.rev())
        with self.assertRaisesRegex(ValueError, "Git diff cannot be verified"):
            policy.check_pr(self.repo, self.base, "not-a-real-commit")

    def test_cli_json_reports_exemptions_and_missing_readmes(self):
        self.write("agents/profiles/candidates/beam.yaml", "id: beam\n")
        self.update("jobs/admission/handler.mjs")
        self.commit("candidate plus runtime")
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--base", self.base,
             "--head", self.rev(), "--repo", str(self.repo), "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        self.assertFalse(report["passed"])
        self.assertEqual(report["missing"][0]["readme"], "jobs/admission/README.md")
        self.assertIn("research", report["exemptions"][0]["reason"])

    def test_pure_readme_edit_does_not_trigger_own_rule(self):
        self.update("agents/README.md")
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertEqual(report["covered"], [])


if __name__ == "__main__":
    unittest.main()
