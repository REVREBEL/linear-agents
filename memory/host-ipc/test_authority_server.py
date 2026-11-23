"""Disposable fixture tests; no live credentials or production listener."""
import importlib.util
import os
import pathlib
import socket
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name("authority-server.py")
spec = importlib.util.spec_from_file_location("authority_server", SOURCE)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
ISSUE = "ABR-59"
REPO = "REVREBEL/linear-agents"
ENTRYPOINT = "/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs"


def fixture():
    return {
        "schemaVersion": 1, "activation": True,
        "releaseSha": "a" * 40,
        "bridge": {"pid": os.getpid(), "startTicks": "10000",
                   "unit": "agent-bridge.service", "entrypoint": ENTRYPOINT},
        "repositories": {"/home/bridge/agent-bridge": REPO},
        "jobs": [{"jobKey": "qwen:delivery-id", "trustedJob": {
            "jobId": "pinned-job", "scope": {
              "tenantId": "workspace", "agentId": "qwen",
              "repositoryId": REPO, "issueId": ISSUE},
            "prNumber": 276, "headSha": "b" * 40},
            "sourcePath": "docs/verified-learnings/pinned.md",
            "policy": {"requiredChecks": ["ci"],
                       "allowedCheckApps": ["github-actions"],
                       "permittedReviewers": ["independent"]}}]
    }


class ManifestTests(unittest.TestCase):
    def test_manifest_pins_exact_scope_and_release(self):
        self.assertEqual(server.checked_manifest(fixture())["jobs"][0]["jobKey"],
                         "qwen:delivery-id")

    def test_unsafe_manifests_fail_closed(self):
        for change in [
            lambda m: m.update(activation=False),
            lambda m: m.update(releaseSha="unknown"),
            lambda m: m["bridge"].update(entrypoint="/home/bridge/main.mjs"),
            lambda m: m["bridge"].update(startTicks="5\n"),
            lambda m: m["repositories"].update({"relative": REPO}),
            lambda m: m["repositories"].update({"/tmp/foreign": "bad repo"}),
            lambda m: m["jobs"].append(dict(m["jobs"][0])),
            lambda m: m["jobs"][0].update(sourcePath="docs/verified-learnings/../../keys.md"),
            lambda m: m["jobs"][0]["trustedJob"].update(headSha="0"),
            lambda m: m["jobs"][0]["trustedJob"]["scope"].update(repositoryId="foreign"),
            lambda m: m["jobs"][0]["policy"].update(allowedCheckApps=[]),
        ]:
            with self.subTest(change=change):
                m = fixture()
                change(m)
                with self.assertRaises(server.Refused):
                    server.checked_manifest(m)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.config = server.checked_manifest(fixture())

    def test_recall_limited_to_exact_pinned_job_and_four_dimensions(self):
        work_calls = []

        def work(*args):
            work_calls.append(args)
            return {"schemaVersion": 1, "trust": "untrusted-reference-only", "entries": []}
        request = {"op": "recall", "tenantId": "workspace", "agentId": "qwen",
                   "repositoryRoot": "/home/bridge/agent-bridge", "issueId": ISSUE,
                   "jobKey": "qwen:delivery-id"}
        self.assertTrue(server.dispatch(request, self.config, worker=work)["ok"])
        self.assertEqual(work_calls, [("recall", "qwen:delivery-id", 8)])
        for k, v in [("tenantId", "other"), ("agentId", "other"),
                     ("repositoryRoot", "/home/bridge/other"), ("issueId", "ABR-60"),
                     ("jobKey", "other:delivery-id")]:
            with self.subTest(key=k):
                with self.assertRaises(server.Refused):
                    server.dispatch({**request, k: v}, self.config, worker=work)
        with self.assertRaises(server.Refused):
            server.dispatch({**request, "sourcePath": "docs/verified-learnings/evil.md"},
                            self.config, worker=work)
        self.assertEqual(len(work_calls), 1)

    def test_repo_mapping_independently_pinned(self):
        self.assertEqual(server.dispatch({"op": "repo",
            "repositoryRoot": "/home/bridge/agent-bridge"}, self.config),
            {"ok": True, "repositoryId": REPO})
        with self.assertRaises(server.Refused):
            server.dispatch({"op": "repo", "repositoryRoot": "/tmp/foreign"}, self.config)

    def test_completion_is_only_hint_for_exact_unique_issue(self):
        calls = []
        self.assertEqual(server.dispatch({"op": "complete", "issueId": ISSUE}, self.config,
            scheduler=lambda *x: calls.append(x)), {"ok": True, "accepted": True})
        self.assertEqual(calls, [("qwen:delivery-id", ISSUE)])
        with self.assertRaises(server.Refused):
            server.dispatch({"op": "complete", "issueId": "ABR-60"}, self.config,
                scheduler=lambda *x: calls.append(x))
        with self.assertRaises(server.Refused):
            server.dispatch({"op": "complete", "issueId": ISSUE}, self.config)
        self.assertEqual(len(calls), 1)

    def test_kernel_so_peercred_accepts_only_exact_main_process_and_release(self):
        # The fixture patches external systemd/proc filesystem lookups, but
        # SO_PEERCRED itself comes from the real kernel socketpair.
        client, accepted = socket.socketpair(socket.AF_UNIX)
        try:
            self.assertEqual(client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12),
                             accepted.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            def mock_text(self):
                return "0::/system.slice/agent-bridge.service"
            def mock_bytes(self):
                return b"node\0" + ENTRYPOINT.encode() + b"\0"
            with patch.object(server.accounts, "getpwnam", return_value=types.SimpleNamespace(
                    pw_uid=os.getuid(), pw_gid=os.getgid())), \
                 patch.object(server, "process_start_ticks", return_value="10000"), \
                 patch.object(server.pathlib.Path, "read_text", mock_text), \
                 patch.object(server.pathlib.Path, "read_bytes", mock_bytes), \
                 patch.object(server, "trusted_path"):
                self.assertTrue(server.peer_authorized(accepted, self.config,
                    main_pid_reader=lambda: os.getpid()))
                with self.assertRaises(server.Refused):
                    server.peer_authorized(accepted, self.config, main_pid_reader=lambda: 1)
                changed = fixture()
                changed["bridge"]["pid"] += 1
                with self.assertRaises(server.Refused):
                    server.peer_authorized(accepted, changed,
                        main_pid_reader=lambda: changed["bridge"]["pid"])
                changed = fixture()
                changed["bridge"]["startTicks"] = "999"
                with self.assertRaises(server.Refused):
                    server.peer_authorized(accepted, changed,
                        main_pid_reader=lambda: os.getpid())
        finally:
            client.close()
            accepted.close()

    def test_protocol_rejects_multiple_and_oversized_messages(self):
        for raw, valid in [
            (b'{"op":"repo","repositoryRoot":"/repo"}\n', True),
            (b'{"op":"repo"}\n{"op":"recall"}\n', False),
            (b'{' + b'a'*2049 + b'}\n', False),
        ]:
            with self.subTest(valid=valid):
                client, accepted = socket.socketpair(socket.AF_UNIX)
                try:
                    client.sendall(raw)
                    if valid:
                        self.assertEqual(server.read_message(accepted)["op"], "repo")
                    else:
                        with self.assertRaises(server.Refused):
                            server.read_message(accepted)
                finally:
                    client.close()
                    accepted.close()


if __name__ == "__main__":
    unittest.main()
