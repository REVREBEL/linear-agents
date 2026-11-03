import ast
import inspect
import json
import os
import tempfile
import unittest
from unittest import mock

import run_agent


class RunAgentTests(unittest.TestCase):
    def test_streaming_progress_interval_references_defined_constant(self):
        # Regression: a step_update at runtime previously raised NameError
        # because the streaming condition referenced AGY_PROGRESS_INTERVAL_SECS.
        tree = ast.parse(inspect.getsource(run_agent))
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        self.assertIn("ANTIGRAVITY_PROGRESS_INTERVAL_SECS", names)
        self.assertNotIn("AGY_PROGRESS_INTERVAL_SECS", names)

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

    def test_format_step_summary_various_tools(self):
        ws = "/path/to/repo"

        # 1. AGY stream-json format: run_command with CommandLine and toolSummary
        step_agy_cmd = {
            "step_type": "tool",
            "tool_name": "run_command",
            "tool_info": {
                "name": "run_command",
                "parameters": {"CommandLine": "git status", "toolSummary": "Check git status"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_agy_cmd, ws), "Running: Check git status (`git status`)")

        # 2. AGY stream-json format: run_command raw
        step_cmd_raw = {
            "step_type": "tool",
            "tool_name": "run_command",
            "tool_info": {
                "name": "run_command",
                "parameters": {"CommandLine": "npm test -- --watchAll=false"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_cmd_raw, ws), "Running command: `npm test -- --watchAll=false`")

        # 3. AGY stream-json format: read_file with line ranges
        step_read = {
            "step_type": "tool",
            "tool_name": "read_file",
            "tool_info": {
                "name": "read_file",
                "parameters": {"Path": "/path/to/repo/src/index.ts", "StartLine": 1, "EndLine": 50}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_read, ws), "Reading `src/index.ts` (lines 1-50)")

        # 4. AGY stream-json format: edit_file
        step_edit = {
            "step_type": "tool",
            "tool_name": "edit_file",
            "tool_info": {
                "name": "edit_file",
                "parameters": {"Path": "/path/to/repo/src/index.ts"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_edit, ws), "Editing `src/index.ts`")

        # 5. AGY stream-json format: manage_task
        step_task_list = {
            "step_type": "tool",
            "tool_name": "manage_task",
            "tool_info": {
                "name": "manage_task",
                "parameters": {"Action": "list"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_task_list, ws), "Listing background tasks")

        step_task_status = {
            "step_type": "tool",
            "tool_name": "manage_task",
            "tool_info": {
                "name": "manage_task",
                "parameters": {"Action": "status", "TaskId": "task-45"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_task_status, ws), "Checking background task status (task-45)")

        # 6. AGY stream-json format: MCP tool
        step_mcp_gh = {
            "step_type": "tool",
            "tool_name": "call_mcp_tool",
            "tool_info": {
                "name": "call_mcp_tool",
                "parameters": {"ServerName": "github", "ToolName": "create_pull_request"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_mcp_gh, ws), "Calling GitHub MCP: `create_pull_request`")

        step_mcp_linear = {
            "step_type": "tool",
            "tool_name": "call_mcp_tool",
            "tool_info": {
                "name": "call_mcp_tool",
                "parameters": {"ServerName": "linear_linear", "ToolName": "get_issue"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_mcp_linear, ws), "Calling Linear MCP: `get_issue`")

        # 7. AGY stream-json format: search_web
        step_search = {
            "step_type": "tool",
            "tool_name": "search_web",
            "tool_info": {
                "name": "search_web",
                "parameters": {"query": "Linear agent webhooks"}
            }
        }
        self.assertEqual(run_agent.format_step_summary(step_search, ws), 'Searching web for "Linear agent webhooks"')

        # 8. Transcript / tool_calls format compatibility
        step_tc = {
            "tool_calls": [{"name": "read_file", "args": {"Path": "/path/to/repo/README.md"}}]
        }
        self.assertEqual(run_agent.format_step_summary(step_tc, ws), "Reading `README.md`")

        # 9. Thought reasoning
        step_thought = {
            "thinking": "Analyzing the implementation requirements and reviewing files...\nExtra details",
            "tool_calls": []
        }
        self.assertEqual(run_agent.format_step_summary(step_thought, ws), "Reasoning: Analyzing the implementation requirements and reviewing f...")


if __name__ == "__main__":
    unittest.main()
