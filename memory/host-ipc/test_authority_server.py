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
from admission import admitted_job
from integrity import reviewed_checkout, trusted_tree, trusted_release_file
server.admitted_job = admitted_job
server.reviewed_checkout = reviewed_checkout
server.trusted_tree = trusted_tree
server.trusted_release_file = trusted_release_file
server.intent = types.SimpleNamespace(read=lambda key: None)
ISSUE = "ABR-59"
REPO = "REVREBEL/linear-agents"
ENTRYPOINT = "/var/lib/bridge-runtime/linear-agent-bridge/agent-bridge.mjs"


def fixture():
    return {
        "schemaVersion": 1, "activation": True,
        "releaseSha": "a" * 40,
        "bridge": {"pid": os.getpid(), "startTicks": "10000",
                   "unit": "agent-bridge.service", "entrypoint": ENTRYPOINT,
                   "releaseSha": "d" * 40},
        "repositories": {"/home/bridge/agent-bridge": REPO},
        "sourceCheckouts": {REPO: {"root": "/var/lib/bridge-memory-sources/linear-agents",
                                   "headSha": "c" * 40}},
        "ledgerRoot": "/home/bridge/agent-bridge/linear-agent-bridge/linear-jobs/job-state",
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
        self.admission_patch = patch.object(server, "admitted_job", return_value=True)
        self.admission_patch.start()
        self.addCleanup(self.admission_patch.stop)

    def test_recall_limited_to_exact_pinned_job_and_four_dimensions(self):
        work_calls = []

        def work(*args):
            work_calls.append(args)
            return {"schemaVersion": 1, "trust": "untrusted-reference-only", "entries": []}
        request = {"op": "recall", "tenantId": "workspace", "agentId": "qwen",
                   "repositoryRoot": "/home/bridge/agent-bridge", "issueId": ISSUE,
                   "jobKey": "qwen:delivery-id"}
        self.assertTrue(server.dispatch(request, self.config, worker=work,
                                         manifest_digest="a"*64)["ok"])
        self.assertEqual(work_calls, [("recall", "qwen:delivery-id", 8, "a"*64)])
        for k, v in [("tenantId", "other"), ("agentId", "other"),
                     ("repositoryRoot", "/home/bridge/other"), ("issueId", "ABR-60"),
                     ("jobKey", "other:delivery-id")]:
            with self.subTest(key=k):
                with self.assertRaises(server.Refused):
                    server.dispatch({**request, k: v}, self.config, worker=work, manifest_digest="a"*64)
        with self.assertRaises(server.Refused):
            server.dispatch({**request, "sourcePath": "docs/verified-learnings/evil.md"},
                            self.config, worker=work, manifest_digest="a"*64)
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
            scheduler=lambda *x: calls.append(x), manifest_digest="a"*64), {"ok": True, "accepted": True, "jobKey": "qwen:delivery-id"})
        self.assertEqual(calls, [("qwen:delivery-id", ISSUE, "a"*64)])
        with self.assertRaises(server.Refused):
            server.dispatch({"op": "complete", "issueId": "ABR-60"}, self.config,
                scheduler=lambda *x: calls.append(x), manifest_digest="a"*64)
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
                 patch.object(server, "trusted_path"), \
                 patch.object(server, "trusted_release_file", return_value=True), \
                 patch.object(server, "reviewed_checkout", return_value=True):
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

class DurableDuplicateCompletionTests(unittest.TestCase):
    def test_root_acknowledges_same_pinned_intent_without_rescheduling(self):
        import threading
        import types
        from unittest.mock import patch
        manifest = server.checked_manifest(fixture())
        digest = "a" * 64
        stored = {}
        jobs = []
        pending = {"keys": set(), "lock": threading.Lock()}
        class Executor:
            def submit(self, task):
                jobs.append(task)
                return object()
        class Connection:
            def __init__(self):
                self.message = b""
                self.closed = False
            def sendall(self, data):
                self.message += data
            def close(self):
                self.closed = True
        def enqueue(key, input_digest):
            if key in stored:
                raise ValueError("duplicate must not reenqueue")
            stored[key] = {"jobKey": key, "state": "queued", "digest": input_digest}
            return True
        private_intent = types.SimpleNamespace(read=lambda key: stored.get(key), enqueue=enqueue,
            write=lambda *args: None)
        def check():
            conn = Connection()
            server.serve_one(conn, Executor(), pending, main_pid_reader=lambda: 1)
            self.assertTrue(conn.closed)
            self.assertEqual(json.loads(conn.message), {
                "ok": True, "accepted": True, "jobKey": "qwen:delivery-id"})
        import json
        with patch.object(server, "private_config", return_value=(manifest,digest)), \
             patch.object(server, "peer_authorized", return_value=True), \
             patch.object(server, "read_message", return_value={"op": "complete","issueId": ISSUE}), \
             patch.object(server, "admitted_job", return_value=True), \
             patch.object(server, "intent", private_intent):
            check()  # first callback actually queues
            self.assertEqual(len(jobs), 1)
            check()  # duplicate while in pending set returns same pin
            self.assertEqual(len(jobs), 1)
            pending["keys"].clear()  # simulated restart / detached in-flight
            check()  # durable intent exists: no new native commit
            self.assertEqual(len(jobs), 1)
            self.assertEqual(stored["qwen:delivery-id"]["state"], "queued")
