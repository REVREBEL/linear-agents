import json
import os
import tempfile
import unittest
from unittest import mock

import run_agent


class RunAgentTests(unittest.TestCase):
    def test_load_job_context_requires_and_returns_completion_url(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({
                "completionUrl": "https://worker.test/complete",
                "payload": {"data": {"promptContext": "Do the task"}},
            }, handle)
            filename = handle.name
        try:
            self.assertEqual(
                run_agent.load_job_context(filename),
                ("Do the task", "https://worker.test/complete"),
            )
        finally:
            os.unlink(filename)

    @mock.patch.dict(os.environ, {"BRIDGE_SHARED_SECRET": "shared"}, clear=False)
    @mock.patch("run_agent.requests.post")
    def test_worker_activity_uses_bridge_secret_and_explicit_type(self, post):
        post.return_value.raise_for_status.return_value = None
        post.return_value.json.return_value = {"ok": True}

        self.assertTrue(run_agent.post_worker_activity(
            "session-1", "https://worker.test/complete", "thought", "Started",
        ))

        _, kwargs = post.call_args
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer shared")
        self.assertEqual(kwargs["json"], {
            "agentSessionId": "session-1",
            "activityType": "thought",
            "body": "Started",
        })

    def test_default_headless_settings_are_narrow(self):
        self.assertEqual(json.loads(run_agent.ANTIGRAVITY_SETTINGS), {
            "permissions": {"allow": ["mcp(github/list_commits)"]},
        })


if __name__ == "__main__":
    unittest.main()
