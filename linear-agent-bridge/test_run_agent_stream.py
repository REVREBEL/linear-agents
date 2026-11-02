import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_agent


class StreamRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addAsyncCleanup(asyncio.to_thread, self.temp.cleanup)
        self.script = Path(self.temp.name) / "mock-agy"
        self.script.write_text("#!" + sys.executable + "\n" + """
import json, sys
mode = __import__('os').environ.get('AGY_TEST_MODE')
if mode == 'output_first':
    sys.stdout.write(json.dumps({'event': 'progress', 'text': 'x' * 300000}) + '\\n')
    sys.stdout.flush()
message = json.loads(sys.stdin.readline())['message']['content']
if mode == 'big_event':
    sys.stdout.write(json.dumps({'event': 'progress', 'text': 'x' * 1500000}) + '\\n')
if mode == 'tool_denied':
    sys.stdout.write(json.dumps({
        'event': 'result',
        'result': {
            'status': 'SUCCESS',
            'response': '',
            'denied_actions': [{'action': 'mcp', 'display_name': 'linear_linear/get_issue'}]
        }
    }) + '\\n')
elif mode == 'empty_response':
    sys.stdout.write(json.dumps({
        'event': 'result',
        'result': {
            'status': 'SUCCESS',
            'response': ''
        }
    }) + '\\n')
else:
    sys.stdout.write(json.dumps({'event': 'result', 'result': {'status': 'SUCCESS', 'response': message}}) + '\\n')
sys.stdout.flush()
""")
        self.script.chmod(0o755)

    async def test_event_larger_than_one_megabyte(self):
        with mock.patch.object(run_agent, "ANTIGRAVITY_BIN", str(self.script)), \
             mock.patch.object(run_agent, "ANTIGRAVITY_WORKSPACE", self.temp.name), \
             mock.patch.dict(os.environ, {"AGY_TEST_MODE": "big_event"}):
            answer = await asyncio.wait_for(run_agent.run_antigravity("real follow-up prompt"), 15)
        self.assertEqual(answer, "real follow-up prompt")

    async def test_output_during_large_stdin_does_not_deadlock(self):
        with mock.patch.object(run_agent, "ANTIGRAVITY_BIN", str(self.script)), \
             mock.patch.object(run_agent, "ANTIGRAVITY_WORKSPACE", self.temp.name), \
             mock.patch.dict(os.environ, {"AGY_TEST_MODE": "output_first"}):
            prompt = "Follow-up " + "x" * 500000
            answer = await asyncio.wait_for(run_agent.run_antigravity(prompt), 15)
        self.assertEqual(answer, prompt)

    async def test_tool_denied_raises_error_with_blocked_details(self):
        with mock.patch.object(run_agent, "ANTIGRAVITY_BIN", str(self.script)), \
             mock.patch.object(run_agent, "ANTIGRAVITY_WORKSPACE", self.temp.name), \
             mock.patch.dict(os.environ, {"AGY_TEST_MODE": "tool_denied"}):
            with self.assertRaises(RuntimeError) as ctx:
                await asyncio.wait_for(run_agent.run_antigravity("check issue"), 15)
            self.assertIn("BLOCKED: Tool permissions were denied", str(ctx.exception))
            self.assertIn("linear_linear/get_issue", str(ctx.exception))

    async def test_empty_response_raises_error(self):
        with mock.patch.object(run_agent, "ANTIGRAVITY_BIN", str(self.script)), \
             mock.patch.object(run_agent, "ANTIGRAVITY_WORKSPACE", self.temp.name), \
             mock.patch.dict(os.environ, {"AGY_TEST_MODE": "empty_response"}):
            with self.assertRaises(RuntimeError) as ctx:
                await asyncio.wait_for(run_agent.run_antigravity("empty turn"), 15)
            self.assertIn("completed without a response", str(ctx.exception))


class FollowUpPromptTests(unittest.IsolatedAsyncioTestCase):
    async def test_main_passes_real_prompt_with_conversation(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as file:
            json.dump({"completionUrl": "https://worker.test/complete", "payload": {"data": {"promptContext": "Inspect new README"}}}, file)
            filename = file.name
        try:
            with mock.patch.object(sys, "argv", ["run_agent.py", "linear-session", filename, "existing-conversation"]), \
                 mock.patch.object(run_agent, "post_worker_activity", return_value=True), \
                 mock.patch.object(run_agent, "run_antigravity", new_callable=mock.AsyncMock, return_value="done") as runner:
                code = await run_agent.main()
            self.assertEqual(code, 0)
            runner.assert_awaited_once_with("Inspect new README", "existing-conversation", progress_callback=mock.ANY)
        finally:
            os.unlink(filename)
