#!/usr/bin/env python3

import asyncio
import json
import os
import sys
import re
from pathlib import Path
from typing import Any

import requests


LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
ANTIGRAVITY_BIN = os.path.expanduser(
    os.getenv("ANTIGRAVITY_BIN", "~/.local/bin/agy")
)
ANTIGRAVITY_PRINT_TIMEOUT = os.getenv("ANTIGRAVITY_PRINT_TIMEOUT", "30m")
ANTIGRAVITY_WORKSPACE = os.path.abspath(
    os.path.expanduser(
        os.getenv("ANTIGRAVITY_WORKSPACE", os.getcwd())
    )
)


def linear_authorization_header() -> str | None:
    """
    OAuth access tokens use Bearer. Linear personal API keys are sent directly.
    Set LINEAR_ACCESS_TOKEN for OAuth, or LINEAR_API_KEY for a personal key.
    """
    access_token = os.getenv("LINEAR_ACCESS_TOKEN")
    if access_token:
        return f"Bearer {access_token}"

    api_key = os.getenv("LINEAR_API_KEY")
    if api_key:
        return api_key

    return None


def update_linear_activity(
    session_id: str,
    activity_type: str,
    message: str,
) -> bool:
    authorization = linear_authorization_header()

    if not authorization:
        print(
            "Missing LINEAR_ACCESS_TOKEN or LINEAR_API_KEY; "
            "cannot send activity to Linear.",
            file=sys.stderr,
        )
        return False

    mutation = """
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
      }
    }
    """

    variables = {
        "input": {
            "agentSessionId": session_id,
            "content": {
                "type": activity_type,
                "body": message,
            },
        }
    }

    try:
        response = requests.post(
            LINEAR_GRAPHQL_URL,
            headers={
                "Authorization": authorization,
                "Content-Type": "application/json",
            },
            json={
                "query": mutation,
                "variables": variables,
            },
            timeout=20,
        )

        response.raise_for_status()
        body: dict[str, Any] = response.json()

        if body.get("errors"):
            print(
                f"Linear GraphQL errors: {json.dumps(body['errors'])}",
                file=sys.stderr,
            )
            return False

        success = bool(
            body.get("data", {})
            .get("agentActivityCreate", {})
            .get("success")
        )

        if not success:
            print(
                "Linear returned success=false for agentActivityCreate.",
                file=sys.stderr,
            )

        return success

    except Exception as error:
        print(
            f"Failed to emit activity to Linear: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return False


def load_prompt(json_file_path: str) -> str:
    with open(json_file_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    prompt = data.get("payload", {}).get("data", {}).get("promptContext")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Missing payload.data.promptContext")
    return prompt.strip()


class QuotaExhausted(Exception):
    def __init__(self, conversation_id: str | None, message: str):
        super().__init__(message)
        self.conversation_id = conversation_id


def quota_exhausted(message: str) -> bool:
    return bool(re.search(
        r"RESOURCE_EXHAUSTED|Individual quota reached|quota (?:has been )?(?:exceeded|exhausted|reached)|rate limit exceeded",
        message, re.I
    ))


def valid_conversation_id(value: Any) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", value):
        return value
    return None


def event_conversation_id(events: list[dict]) -> str | None:
    for event in events:
        for entry in (event, event.get("result")):
            if isinstance(entry, dict):
                value = valid_conversation_id(entry.get("conversation_id") or entry.get("conversationId"))
                if value:
                    return value
    return None


async def run_antigravity(prompt: str, conversation_id: str | None = None) -> str:
    if not os.path.isfile(ANTIGRAVITY_BIN) or not os.access(ANTIGRAVITY_BIN, os.X_OK):
        raise FileNotFoundError(f"Antigravity CLI not executable: {ANTIGRAVITY_BIN}")
    if not os.path.isdir(ANTIGRAVITY_WORKSPACE):
        raise NotADirectoryError(ANTIGRAVITY_WORKSPACE)

    command = [
        ANTIGRAVITY_BIN, "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT, "--sandbox",
    ]
    if conversation_id:
        command.extend(["--conversation", conversation_id])
    input_message = json.dumps(
        {"event": "user", "message": {"content": prompt}},
        ensure_ascii=False,
    ) + "\n"

    process = await asyncio.create_subprocess_exec(
        *command, cwd=ANTIGRAVITY_WORKSPACE, env=os.environ.copy(),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await process.communicate(input=input_message.encode("utf-8"))
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()
    events = []
    result = None
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        events.append(event)
        if event.get("event") == "result" and isinstance(event.get("result"), dict):
            result = event["result"]

    # Never use -c or a workspace's "last conversation" in a multi-issue bridge.
    # Require the actual run to report its conversation ID.
    resolved_id = conversation_id or event_conversation_id(events)
    error_text = str(result.get("error") or "") if result else ""
    diagnostic = "\n".join((error_text, stderr, stdout[-2000:]))
    if quota_exhausted(diagnostic) and (result is None or result.get("status") != "SUCCESS"):
        raise QuotaExhausted(resolved_id, diagnostic[-1000:])
    if result is None:
        raise RuntimeError(f"AGY exited {process.returncode} without terminal result: {stderr[-1500:]}")
    if process.returncode != 0 or result.get("status") != "SUCCESS":
        raise RuntimeError(f"AGY status {result.get('status')}: {error_text or stderr}")
    response = result.get("response")
    if not isinstance(response, str) or not response.strip():
        raise RuntimeError("Antigravity CLI completed without a response.")
    return response.strip()


async def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: run_agent.py <agentSessionId> <jobPath> [conversationId]", file=sys.stderr)
        return 1
    session_id, json_file_path = sys.argv[1:3]
    resumed_conversation = sys.argv[3] if len(sys.argv) > 3 else None
    update_linear_activity(session_id, "thought", "Antigravity has initialized locally and is analyzing the task.")
    try:
        prompt = load_prompt(json_file_path)
        if resumed_conversation:
            prompt = (
                "Resume the existing Linear task where you stopped. Review the work already "
                "completed and continue only the unfinished steps; do not repeat changes."
            )
        response = await run_antigravity(prompt, resumed_conversation)
        print(response)
        update_linear_activity(session_id, "response", f"Task completed.\n\n{response}")
        return 0
    except QuotaExhausted as error:
        event = {"event": "on_exhaustion", "conversation_id": error.conversation_id}
        print("AGY_BRIDGE_EVENT=" + json.dumps(event), flush=True)
        update_linear_activity(session_id, "thought", "Antigravity quota exhausted; a retry will be scheduled if the session can be identified.")
        return 75
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        print(f"Execution failure: {message}", file=sys.stderr)
        update_linear_activity(session_id, "error", f"Local execution failed.\n\n{message}")
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
