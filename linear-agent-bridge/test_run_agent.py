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

    def test_default_settings_and_sandbox_inherit_native_permissions(self):
        self.assertEqual(run_agent.ANTIGRAVITY_SETTINGS, "")
        self.assertFalse(run_agent.ANTIGRAVITY_SANDBOX)
        self.assertEqual(run_agent.ANTIGRAVITY_MODE, "cli")

    @mock.patch("subprocess.run")
    def test_open_desktop_workspace_in_desktop_mode(self, mock_run):
        with mock.patch.object(run_agent, "ANTIGRAVITY_MODE", "desktop"), \
             mock.patch.object(run_agent.sys, "platform", "darwin"):
            result = run_agent.open_desktop_workspace("/tmp/test-workspace")
            self.assertTrue(result)
            mock_run.assert_called_once_with(
                ["open", "-a", "Antigravity", "/tmp/test-workspace"],
                check=False,
                capture_output=True,
            )

    @mock.patch("subprocess.run")
    def test_open_desktop_workspace_in_cli_mode_is_silent(self, mock_run):
        with mock.patch.object(run_agent, "ANTIGRAVITY_MODE", "cli"):
            result = run_agent.open_desktop_workspace("/tmp/test-workspace")
            self.assertFalse(result)
            mock_run.assert_not_called()

    @mock.patch.dict(os.environ, {
        "LINEAR_API_KEY": "personal-key",
        "LINEAR_ACCESS_TOKEN": "local-token",
        "UNRELATED_SETTING": "preserved",
        "BRIDGE_SHARED_SECRET": "secret",
    }, clear=False)
    def test_antigravity_subprocess_does_not_receive_linear_credentials(self):
        environment = run_agent.antigravity_subprocess_env()

        self.assertNotIn("LINEAR_API_KEY", environment)
        self.assertNotIn("LINEAR_ACCESS_TOKEN", environment)
        self.assertNotIn("BRIDGE_SHARED_SECRET", environment)
        self.assertEqual(environment["UNRELATED_SETTING"], "preserved")


if __name__ == "__main__":
    unittest.main()
