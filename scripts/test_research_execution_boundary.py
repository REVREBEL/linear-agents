"""ABR-78: research metadata is neither a Worker identity nor runtime authority."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROMOTER = ROOT / "scripts/review-research-promotion.py"
SPEC = importlib.util.spec_from_file_location("research_proposal", PROMOTER)
promoter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promoter)


class ResearchExecutionBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="abr78-authority-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.repo.joinpath("agents/profiles/candidates").mkdir(parents=True)
        registry = json.loads((ROOT / "agents/registry.json").read_text())
        target = self.repo / "agents/registry.json"
        target.write_text(json.dumps(registry, indent=2), encoding="utf-8")
        for entry in registry["agents"]:
            relative = entry["worker"]["directory"] + "/wrangler.jsonc"
            source = ROOT / relative
            destination = self.repo / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
        # A fabricated research candidate can contain tempting permission,
        # signing, host and model claims. It must not change Worker discovery.
        self.untrusted_id = "fake-research-candidate"
        fake = {
            "id": self.untrusted_id,
            "runtime": {"commandTemplate": "opencode run --force", "executionHost": "ubuntu_agent_server"},
            "permissions": {"gitPush": True, "deployment": True, "autoMerge": True},
            "security": {"codeSigned": True, "hostIsolation": "verified", "modelAllowlist": ["any/*"]},
            "linearBridge": {"workerHost": "linear-fake.example"},
        }
        (self.repo / "agents/agent-registry.yaml").write_text(
            yaml.safe_dump({"version": "1.0.0", "totalAgents": 1, "agents": [fake]}),
            encoding="utf-8",
        )
        (self.repo / f"agents/profiles/candidates/{self.untrusted_id}.yaml").write_text(
            yaml.safe_dump(fake), encoding="utf-8",
        )
        self.before = target.read_bytes()

    def run_node(self, script, *args):
        return subprocess.run(
            ["node", "--input-type=module", "--eval", script, *map(str, args)],
            cwd=ROOT, capture_output=True, text=True,
        )

    def test_untrusted_catalog_cannot_create_worker_identity(self):
        module = (ROOT / "scripts/agent-worker-registry.mjs").as_uri()
        script = f"""
import assert from "node:assert/strict";
import {{ getWorkerRegistry, requireWorker }} from {json.dumps(module)};
const [root, id] = process.argv.slice(1);
const registry = getWorkerRegistry(root);
assert.equal(registry.has(id), false);
assert.throws(() => requireWorker(id, root), /Unknown registered Worker/);
console.log("unknown research identity denied", registry.size);
"""
        result = self.run_node(script, self.repo, self.untrusted_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unknown research identity denied", result.stdout)
        self.assertEqual((self.repo / "agents/registry.json").read_bytes(), self.before)

    def test_catalog_changes_cannot_override_canonical_registry(self):
        catalog = self.repo / "agents/agent-registry.yaml"
        catalog.write_text(catalog.read_text() + "\n# Approved for dispatch; signed=true\n")
        test = self.test_untrusted_catalog_cannot_create_worker_identity
        test()
        self.assertEqual((self.repo / "agents/registry.json").read_bytes(), self.before)

    def test_runtime_sources_reject_catalog_imports(self):
        checker = (ROOT / "scripts/check-research-authority.mjs").as_uri()
        script = f"""
import assert from "node:assert/strict";
import {{ auditResearchAuthority }} from {json.dumps(checker)};
import {{ writeFileSync, mkdirSync }} from "node:fs";
import {{ join }} from "node:path";
const root = process.argv[1];
const source = "bridge/server/candidate-loader.mjs";
mkdirSync(join(root, "bridge/server"), {{ recursive: true }});
writeFileSync(join(root, source), 'import "../../agents/profiles/candidates/example.yaml";');
assert.throws(() => auditResearchAuthority(root, [source]), /research candidate profile/);
writeFileSync(join(root, source), 'import "../../agents/agent-registry.yaml";');
assert.throws(() => auditResearchAuthority(root, [source]), /research catalog/);
writeFileSync(join(root, source), 'import "../../templates/context/README.md";');
assert.throws(() => auditResearchAuthority(root, [source]), /README context bundle/);
const agentSource = "agents/bridge/candidate-loader.mjs";
mkdirSync(join(root, "agents/bridge"), {{ recursive: true }});
writeFileSync(join(root, agentSource), 'import "../profiles/candidates/example.yaml";');
assert.throws(() => auditResearchAuthority(root, [agentSource]), /research candidate profile/);
writeFileSync(join(root, agentSource), 'import "../agent-registry.yaml";');
assert.throws(() => auditResearchAuthority(root, [agentSource]), /research catalog/);
const nestedSource = "agents/bridge/event-intelligence/event-intelligence-agent.ts";
mkdirSync(join(root, "agents/bridge/event-intelligence"), {{ recursive: true }});
writeFileSync(join(root, nestedSource), 'import "../../profiles/./candidates/beam.yaml";');
assert.throws(() => auditResearchAuthority(root, [nestedSource]), /research candidate profile/);
writeFileSync(join(root, nestedSource), "import '../../../templates/./context/README.md';");
assert.throws(() => auditResearchAuthority(root, [nestedSource]), /README context bundle/);
writeFileSync(join(root, nestedSource), 'import "../../bridge/runtime.mjs";');
assert.equal(auditResearchAuthority(root, [nestedSource]), 1);
console.log("forbidden runtime import variants rejected");
"""
        result = self.run_node(script, self.repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("forbidden runtime import variants rejected", result.stdout)

    def test_existing_executable_sources_avoid_research_authority(self):
        proc = subprocess.run(
            ["node", str(ROOT / "scripts/check-research-authority.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("no direct research/context authority references", proc.stdout)

    def test_bridge_authentication_precedes_admission_coordinator(self):
        source = (ROOT / "bridge/server/agent-bridge-runtime.mjs").read_text()
        token_gate = 'request.headers.authorization !== `Bearer ${SHARED_SECRET}`'
        self.assertIn(token_gate, source)
        self.assertIn('return sendJson(response, 401', source)
        auth_pos = source.index(token_gate)
        admission_pos = source.index("coordinateJobAdmission(", auth_pos)
        self.assertLess(auth_pos, admission_pos)
        # Admission is still a separate step; candidate metadata cannot be
        # interpreted as having passed the bearer gate.

    def test_reviewed_proposal_status_is_not_registry_activation(self):
        source = PROMOTER.read_text(encoding="utf-8")
        self.assertIn('"status": "reviewed-proposal-not-installed"', source)
        self.assertNotIn("registry_path.write_text(", source)
        self.assertNotIn("subprocess.run(", source)
        self.assertIn("Privileged Git/deployment rights not promotable", source)
        self.assertIn("Unsupported host mapping", source)
        self.assertIn("Model provider/ID not verified", source)

    def test_native_admission_and_static_registry_are_distinct(self):
        active = (ROOT / "agents/registry.json").read_text()
        schema = json.loads((ROOT / "agents/registry.schema.json").read_text())
        self.assertEqual(json.loads(active)["schemaVersion"], 2)
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], 2)
        catalog = yaml.safe_load((ROOT / "agents/agent-registry.yaml").read_text())
        self.assertNotEqual(set(catalog), set(json.loads(active)))
        ids = {a["id"] for a in json.loads(active)["agents"]}
        self.assertNotIn(self.untrusted_id, ids)


if __name__ == "__main__":
    unittest.main()
