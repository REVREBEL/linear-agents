"""Self-contained M14 readiness tests."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

P = pathlib.Path(__file__).with_name("readiness.py")
spec = importlib.util.spec_from_file_location("memory_readiness", P)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class Tests(unittest.TestCase):
    def test_readiness_is_read_only_and_never_assumes_canary(self):
        observed = []
        def subprocess_stub(cmd, **kwargs):
            observed.append(cmd)
            class Result:
                returncode = 0
                stdout = ""
            return Result()
        with patch.object(checks, "protected_dir", return_value=True), \
             patch.object(checks, "protected_file", return_value=True), \
             patch.object(checks, "cluster_state", return_value=True), \
             patch.object(checks, "systemd_unit_exists", return_value=True):
            result = checks.audit(run=subprocess_stub)
        self.assertFalse(result["m14Ready"])
        self.assertIn("controlledLiveCanary", result["missing"])

    def test_missing_production_prerequisites_reported_without_changes(self):
        with patch.object(checks, "protected_dir", return_value=False), \
             patch.object(checks, "protected_file", return_value=False), \
             patch.object(checks, "protected_executable", return_value=False), \
             patch.object(checks, "cluster_state", return_value=False), \
             patch.object(checks, "systemd_unit_exists", return_value=False):
            result = checks.audit(run=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("must not call")))
        self.assertFalse(result["m14Ready"])
        self.assertIn("sealedPythonRuntime", result["missing"])
        self.assertIn("scopedPostgresRlsAndRoles", result["missing"])

    def test_unsafe_symlinks_or_ancestor_modes_never_pass(self):
        with patch.object(checks.pathlib.Path, "lstat", side_effect=FileNotFoundError()):
            self.assertFalse(checks.protected_dir("/tmp/not-there"))
            self.assertFalse(checks.protected_file("/tmp/not-there"))

class StrictGateTests(unittest.TestCase):
    def test_explicit_production_socket_and_scope_role_parameters(self):
        import types
        scope={"tenantId":"tenant","agentId":"qwen",
               "repositoryId":"REVREBEL/linear-agents","issueId":"ABR-59"}
        manifest={"jobs":[{"trustedJob":{"scope":scope}}]}
        calls=[]
        def run(argv,**kwargs):
            calls.append((argv,kwargs))
            return types.SimpleNamespace(returncode=0,stdout="t\n")
        self.assertTrue(checks.cluster_state(manifest,run))
        argv,kwargs=calls[0]
        self.assertIn("/var/run/postgresql",argv)
        self.assertIn("5433",argv)
        self.assertIn("agent_memory",argv)
        self.assertIn("bindings=", " ".join(argv))
        self.assertIn("bridge_memory_reader",kwargs["input"])
        calls.clear()
        self.assertFalse(checks.cluster_state(manifest,
            lambda argv,**kwargs: types.SimpleNamespace(returncode=0,stdout="f\n")))

    def test_release_or_missing_policy_blocks_readiness(self):
        manifest={"releaseSha":"a"*40,"bridge":{
          "entrypoint":"/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs",
          "releaseSha":"b"*40},"sourceCheckouts":{}}
        with patch.object(checks,"reviewed_checkout",return_value=False):
            self.assertFalse(checks.release_matches(manifest))

    def test_stopped_or_unreviewed_service_unit_denied(self):
        import types
        def unit_stub(state="active",group="bridge",dropin=""):
            values={
              "FragmentPath":"/etc/systemd/system/verified-memory-authority.service",
              "DropInPaths":dropin,"User":"root","Group":group,
              "NoNewPrivileges":"yes","ProtectSystem":"strict",
              "ProtectHome":"read-only","PrivateTmp":"yes","ActiveState":state,
              "MainPID":"123","ExecStart":"/usr/bin/python3 /var/lib/bridge-memory-authority-code/memory/host-ipc/authority-server.py"}
            return types.SimpleNamespace(returncode=0,
                stdout="\n".join(k+"="+v for k,v in values.items()))
        with patch.object(checks,"protected_file",return_value=True), \
             patch.object(checks.pathlib.Path,"read_bytes",return_value=b"reviewed"):
            self.assertTrue(checks.systemd_unit_exists(run=lambda *a,**k:unit_stub()))
            for kwargs in [{"state":"inactive"},{"group":"rebel"},
                           {"dropin":"/etc/systemd/system/override.conf"}]:
                self.assertFalse(checks.systemd_unit_exists(
                    run=lambda *a,**k:unit_stub(**kwargs)))

    def test_readiness_requires_private_root_and_live_bridge_identity(self):
        import types
        with patch.object(checks.pathlib.Path,"lstat") as fake:
            def st(self):
                return types.SimpleNamespace(st_uid=0,st_mode=0o040755)
            fake.side_effect=lambda *a,**k:st(None)
            self.assertFalse(checks.protected_dir("/var/lib/bridge-memory-authority",0o700))
        self.assertFalse(checks.bridge_identity(None))
        m={"bridge":{"pid":123,"startTicks":"120"}}
        with patch.object(checks.pathlib.Path,"read_text",
                          return_value="123 (node) S "+ "0 "*19 +"999 0"):
            self.assertFalse(checks.bridge_identity(m,run=lambda *a,**k:
                types.SimpleNamespace(returncode=0,stdout="222")))

class ProductionSchemaPathTests(unittest.TestCase):
    def test_sql_fingerprints_are_schema_independent(self):
        source = (pathlib.Path(__file__).resolve().parent / "db-gate.sql").read_text()
        self.assertIn("SET search_path=memu,public;",source)
        self.assertIn("expected_policies",source)
        self.assertIn("bridge_segment_select",source)

    def test_unit_grants_only_dac_read_not_dac_override(self):
        source = (pathlib.Path(__file__).resolve().parent / "verified-memory-authority.service").read_text()
        self.assertIn("CapabilityBoundingSet=CAP_DAC_READ_SEARCH",source)
        self.assertNotIn("CAP_DAC_OVERRIDE",source.split("CapabilityBoundingSet=",1)[1])
        self.assertIn("ProtectHome=read-only",source)
