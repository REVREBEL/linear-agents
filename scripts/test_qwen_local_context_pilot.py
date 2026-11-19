"""ABR-85 E1: isolated local Qwen research and context pilot regressions."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SCRIPT = ROOT / "scripts/agent-context-handoff.py"
SPEC = importlib.util.spec_from_file_location("qwen_handoff", SCRIPT)
handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handoff)
CANDIDATE = ROOT / "agents/profiles/candidates/qwen-local.yaml"
CONFIG = ROOT / "docs/blueprints/agent-context/qwen-local.opencode.v1.example.json"
HOSTS = {
    "AGENT_CONTEXT_AGENTS_ROOT": "agents",
    "AGENT_CONTEXT_AGENT_TOOLS_ROOT": "agent-tools",
    "AGENT_CONTEXT_GLOBAL_TOOLS_ROOT": "global-tools",
}


class QwenLocalPilotTests(unittest.TestCase):
    def test_candidate_mirrors_research_catalog_but_never_registry_v2(self):
        candidate = yaml.safe_load(CANDIDATE.read_text())
        catalog = yaml.safe_load((ROOT / "agents/agent-registry.yaml").read_text())
        schema = json.loads((ROOT / "templates/context/agent-profile.entry.schema.json").read_text())
        Draft202012Validator(schema).validate(candidate)
        self.assertEqual(catalog["totalAgents"], len(catalog["agents"]))
        self.assertEqual([x["id"] for x in catalog["agents"]].count("qwen-local"), 1)
        self.assertEqual(next(x for x in catalog["agents"] if x["id"] == "qwen-local"), candidate)
        self.assertNotIn("profileVersion", candidate)
        self.assertEqual(candidate["runtime"]["transport"], "headless_cli")
        self.assertEqual(candidate["model"], "ollama/qwen3.5:9b-opencode")
        self.assertEqual(candidate["runtime"]["executionHost"], "ubuntu_agent_server")
        self.assertTrue(candidate["linearBridge"]["workerHost"].endswith(".invalid"))
        self.assertTrue(candidate["linearBridge"]["tunnelHost"].endswith(".invalid"))
        self.assertFalse(any(candidate["permissions"].values()))
        self.assertNotIn("qwen-local", {
            x["id"] for x in json.loads((ROOT / "agents/registry.json").read_text())["agents"]
        })

    def test_staged_config_cannot_switch_to_remote_provider(self):
        config = json.loads(CONFIG.read_text())
        self.assertEqual(set(config["provider"]), {"ollama"})
        self.assertEqual(config["provider"]["ollama"]["npm"], "@ai-sdk/openai-compatible")
        self.assertEqual(config["provider"]["ollama"]["options"], {
            "baseURL": "http://127.0.0.1:11434/v1"
        })
        self.assertEqual(set(config["provider"]["ollama"]["models"]), {"qwen3.5:9b-opencode"})
        self.assertEqual(config["model"], "ollama/qwen3.5:9b-opencode")
        self.assertEqual(
            config["provider"]["ollama"]["models"]["qwen3.5:9b-opencode"]["limit"],
            {"context": 16384, "output": 4096},
        )
        self.assertNotIn("providers", config)

    def test_existing_handoff_replays_qwen_context_without_host_dependency(self):
        with tempfile.TemporaryDirectory(prefix="abr85-qwen-context-") as temp:
            roots = {}
            for key, folder in HOSTS.items():
                path = Path(temp) / folder
                path.mkdir()
                raw = subprocess.check_output([
                    "git", "-C", str(ROOT), "show",
                    "HEAD:templates/context/host-roots/" + folder + "/README.md",
                ])
                (path / "README.md").write_bytes(raw)
                roots[key] = str(path)
            envelope = handoff.create_handoff(
                ROOT, "REVREBEL/linear-agents",
                "Review Qwen Local's research candidate, do not deploy.",
                topic="profiles", environ=roots,
            )
            doc_ids = {d["id"] for d in envelope["contextBundle"]["documents"]}
            self.assertTrue({
                "repo.agents", "repo.bridge", "host.agent-runtimes",
                "host.agent-tools", "host.global-tools",
            }.issubset(doc_ids))
            self.assertEqual(envelope["contextBundle"]["selection"], {
                "mode": "topic", "value": "profiles"
            })
            handoff.verify_handoff(envelope, repo_root=ROOT, check_source=True)
            for key, folder in HOSTS.items():
                (Path(roots[key]) / "README.md").unlink()
            handoff.verify_handoff(envelope, repo_root=ROOT, check_source=True)


if __name__ == "__main__":
    unittest.main()
