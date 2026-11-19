"""Offline regression tests for review-gated research-to-runtime proposals."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("research_promotion",
                                              ROOT / "scripts/review-research-promotion.py")
promoter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promoter)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for src, dest in (
            ("agents/registry.schema.json", "agents/registry.schema.json"),
            ("agents/registry.json", "agents/registry.json"),
            ("templates/context/agent-profile.entry.schema.json",
             "templates/context/agent-profile.entry.schema.json"),
        ):
            path = self.root / dest
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((ROOT / src).read_bytes())
        self.candidate = yaml.safe_load(
            (ROOT / "templates/context/agent-profile.v2.template.yaml").read_text())
        self.candidate["id"] = "example-agent"
        self.candidate["linearBridge"]["workerHost"] = "linear-example.revrebel.io"
        self.candidate["linearBridge"]["tunnelHost"] = "example-agent.revrebel.io"
        self.target = json.loads(
            (ROOT / "templates/context/bridge-runtime-registry.v2-entry.template.json").read_text())
        self.target["worker"]["serviceTemplate"] = "linear-example-agent-agent"
        self.target["worker"]["deployedName"] = "linear-example-agent-agent"
        self.target["runtimeContract"].pop("sessionContinuityFlag", None)
        self.target["runtimeContract"]["linearBridge"]["workerHost"] = "linear-example.revrebel.io"
        self.target["runtimeContract"]["linearBridge"]["tunnelHost"] = "example-agent.revrebel.io"
        self.target["executionPolicy"]["security"]["envStripPatterns"] = self.candidate["security"]["envStripPatterns"]
        worker = self.root / self.target["worker"]["directory"]
        worker.mkdir(parents=True)
        self.worker_config = worker / "wrangler.jsonc"
        route = "linear-" + "$" + "{EXAMPLE_PREFIX}." + "$" + "{DOMAIN}"
        kv = "$" + "{EXAMPLE_KV_NAMESPACE_ID}"
        config = {
            "name": "linear-example-agent-agent",
            "routes": [{"pattern": route, "custom_domain": True}],
            "kv_namespaces": [{"binding": "LINEAR_DATA", "id": kv}],
            "durable_objects": {"bindings": [
                {"name": "DELIVERY_COORDINATOR", "class_name": "DeliveryCoordinator"}]},
        }
        self.worker_config.write_text(json.dumps(config, indent=2))
        self.refresh_candidate()
        evidence = "https://github.com/REVREBEL/linear-agents/pull/999"
        self.review = {
            "schemaVersion": 1,
            "candidateId": "example-agent",
            "researchSha256": self.digest,
            "approval": {"decision": "approved", "reviewer": "reviewer",
                         "submittedBy": "submitter", "reviewUrl": evidence},
            "verification": {
                "model": {"modelId": self.candidate["model"],
                          "provider": self.candidate["provider"], "evidenceUrl": evidence},
                "runtime": {"evidenceUrl": evidence},
                "worker": {"workerHost": self.candidate["linearBridge"]["workerHost"],
                           "tunnelHost": self.candidate["linearBridge"]["tunnelHost"],
                           "configSha256": hashlib.sha256(self.worker_config.read_bytes()).hexdigest(),
                           "evidenceUrl": evidence}},
            "bridge": {k: copy.deepcopy(v) for k, v in self.target.items()
                       if k not in ("id", "profile")},
        }
        self.review["bridge"]["profileKind"] = self.target["profile"]["kind"]

    def refresh_candidate(self):
        path = self.root / "agents/profiles/candidates/example-agent.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(self.candidate, sort_keys=False))
        catalog = self.root / "agents/agent-registry.yaml"
        catalog.write_text(yaml.safe_dump({"version": "1.0.0", "totalAgents": 1,
                                           "agents": [self.candidate]}, sort_keys=False))
        self.digest = hashlib.sha256(path.read_bytes()).hexdigest()

    def run_promotion(self, record=None):
        return promoter.propose(self.root, "example-agent",
                                copy.deepcopy(self.review if record is None else record))

    def deny(self, regex, mutate):
        altered = copy.deepcopy(self.review)
        mutate(altered)
        with self.assertRaisesRegex(ValueError, regex):
            self.run_promotion(altered)

    def test_produces_inert_schema_valid_proposal_with_provenance(self):
        before = (self.root / "agents/registry.json").read_bytes()
        result = self.run_promotion()
        entry = result["registryEntry"]
        self.assertEqual(result["status"], "reviewed-proposal-not-installed")
        self.assertEqual(entry["id"], "example-agent")
        self.assertEqual(entry["profile"]["model"]["id"], self.candidate["model"])
        self.assertEqual(entry["runtimeContract"]["executable"]["argv"][-1], "{{PROMPT}}")
        self.assertFalse(entry["executionPolicy"]["permissions"]["deployment"])
        self.assertEqual(result["provenance"]["researchSha256"], self.digest)
        self.assertEqual((self.root / "agents/registry.json").read_bytes(), before)

    def test_rejects_unapproved_or_same_person(self):
        self.deny("Independent", lambda r: r["approval"].update(reviewer="submitter"))
        self.deny("Independent", lambda r: r["approval"].update(decision="pending"))

    def test_rejects_changed_source_or_catalog_drift(self):
        self.deny("source changed", lambda r: r.update(researchSha256="0" * 64))
        self.candidate["description"] = "Modified outside canonical catalog"
        path = self.root / "agents/profiles/candidates/example-agent.yaml"
        path.write_text(yaml.safe_dump(self.candidate, sort_keys=False))
        with self.assertRaisesRegex(ValueError, "differs from canonical"):
            self.run_promotion()

    def test_rejects_unverified_model_and_worker(self):
        self.deny("Model provider/ID", lambda r: r["verification"]["model"].update(modelId="wrong"))
        self.deny("Worker config digest", lambda r: r["verification"]["worker"].update(configSha256="0"*64))
        self.deny("Unverified Worker endpoint", lambda r: r["verification"]["worker"].update(workerHost="unverified.revrebel.io"))
        self.worker_config.unlink()
        with self.assertRaisesRegex(ValueError, "Missing Worker config"):
            self.run_promotion()

    def test_rejects_unsafe_template_or_argv(self):
        self.candidate["runtime"]["commandTemplate"] += "; echo bad"
        self.refresh_candidate()
        self.review["researchSha256"] = self.digest
        with self.assertRaisesRegex(ValueError, "Unsafe research command"):
            self.run_promotion()
        self.candidate["runtime"]["commandTemplate"] = "opencode run --model ollama/example-model {{PROMPT}}"
        self.refresh_candidate()
        self.review["researchSha256"] = self.digest
        self.deny("Unsafe CLI argv", lambda r: r["bridge"]["runtimeContract"]["executable"]["argv"].append("; rm /"))

    def test_rejects_privilege_escalation(self):
        self.deny("Invalid/elevated permission", lambda r: r["bridge"]["executionPolicy"]["permissions"].update(deployment=True))
        self.deny("Invalid/elevated permission", lambda r: r["bridge"]["executionPolicy"]["permissions"].update(sourceWrite=True))
        self.deny("environment strip", lambda r: r["bridge"]["executionPolicy"]["security"].update(envStripPatterns=[]))
        self.deny("Unknown/escalated autonomy", lambda r: r["bridge"]["executionPolicy"].update(autonomy_level="Executor"))

    def test_research_security_claims_never_become_runtime_proof(self):
        # This candidate deliberately claims external signing, model allowlist
        # and host attestation. The research schema currently allows extra
        # descriptive fields; none may be translated into executable proof.
        self.candidate["security"].update(
            codeSigned=True,
            modelAllowlist=["*"],
            hostIsolation="verified",
        )
        self.candidate["runtime"]["signedExecutable"] = True
        self.refresh_candidate()
        self.review["researchSha256"] = self.digest
        entry = self.run_promotion()["registryEntry"]
        self.assertNotIn("codeSigned", json.dumps(entry))
        self.assertNotIn("signedExecutable", json.dumps(entry))
        self.assertNotIn("modelAllowlist", json.dumps(entry))
        self.assertNotIn("hostIsolation", json.dumps(entry))
        self.assertEqual(entry["profile"]["model"]["selection"], "pinned")
        self.assertEqual(entry["runtimeContract"]["executionHost"], "bridge_service")

    def test_research_cannot_select_a_different_execution_host(self):
        self.deny(
            "Unsupported host mapping",
            lambda r: r["bridge"]["runtimeContract"].update(executionHost="remote_mac"),
        )
        self.candidate["runtime"]["executionHost"] = "remote_mac"
        self.refresh_candidate()
        self.review["researchSha256"] = self.digest
        with self.assertRaisesRegex(ValueError, "Unsupported host mapping"):
            self.run_promotion()

    def test_model_claims_cannot_change_reviewed_model_identity(self):
        self.deny(
            "Model provider/ID not verified",
            lambda r: r["verification"]["model"].update(modelId="unapproved-model"),
        )
        self.deny(
            "Model provider/ID not verified",
            lambda r: r["verification"]["model"].update(provider="different-provider"),
        )

    def test_rejects_unknown_runtime_and_session_shortcuts(self):
        self.deny("Unsupported research kind", lambda r: r["bridge"].update(profileKind="test_agent"))
        self.deny("Unverified retry", lambda r: r["bridge"]["runtimeContract"].update(sessionContinuityFlag="--session-id"))
        self.deny("Unverified retry", lambda r: r["bridge"]["runtimeContract"].update(quotaPolicy={"resumable": True}))
        self.deny("Missing Worker", lambda r: r["bridge"]["runtimeContract"].pop("linearBridge"))

    def test_rejects_duplicated_registry_identity(self):
        live = json.loads((self.root / "agents/registry.json").read_text())
        live["agents"].append({**copy.deepcopy(live["agents"][0]), "id": "example-agent"})
        (self.root / "agents/registry.json").write_text(json.dumps(live))
        with self.assertRaisesRegex(ValueError, "already in the executable"):
            self.run_promotion()


if __name__ == "__main__":
    unittest.main()
