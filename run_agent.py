#!/usr/bin/env python3

import asyncio
import json
import os
import sys
from typing import Any

import requests


LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
AGY_BIN = os.path.expanduser(
    os.getenv("AGY_BIN", "~/.local/bin/agy")
)
AGY_PRINT_TIMEOUT = os.getenv("AGY_PRINT_TIMEOUT", "30m")
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
    with open(json_file_path, "r", encoding="utf-8") as file:
        job_data = json.load(file)

    prompt = (
        job_data.get("payload", {})
        .get("data", {})
        .get("promptContext")
    )

    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("No payload.data.promptContext found in saved job.")

    return prompt.strip()


async def run_antigravity(prompt: str) -> str:
    """Run one Antigravity CLI turn using cached local authentication."""
    if not os.path.isfile(AGY_BIN) or not os.access(AGY_BIN, os.X_OK):
        raise FileNotFoundError(f"Antigravity CLI is not executable: {AGY_BIN}")

    if not os.path.isdir(ANTIGRAVITY_WORKSPACE):
        raise NotADirectoryError(
            f"Antigravity workspace does not exist: {ANTIGRAVITY_WORKSPACE}"
        )

    command = [
        AGY_BIN,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--print-timeout",
        AGY_PRINT_TIMEOUT,
        "--sandbox",
    ]
    input_message = json.dumps(
        {"event": "user", "message": {"content": prompt}},
        ensure_ascii=False,
    ) + "\n"

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=ANTIGRAVITY_WORKSPACE,
        env=os.environ.copy(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await process.communicate(
        input=input_message.encode("utf-8")
    )
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()

    terminal_result: dict[str, Any] | None = None
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "result" and isinstance(
            event.get("result"), dict
        ):
            terminal_result = event["result"]

    if terminal_result is None:
        diagnostic = stderr[-4000:] if stderr else "No terminal result received."
        raise RuntimeError(
            f"Antigravity CLI exited {process.returncode}: {diagnostic}"
        )

    status = str(terminal_result.get("status", "UNKNOWN"))
    if process.returncode != 0 or status != "SUCCESS":
        error = terminal_result.get("error") or stderr or "Unknown error"
        raise RuntimeError(f"Antigravity CLI status {status}: {error}")

    response = terminal_result.get("response")
    if not isinstance(response, str) or not response.strip():
        raise RuntimeError("Antigravity CLI completed without a response.")

    return response.strip()


async def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: run_agent.py <agentSessionId> <jsonFilePath>",
            file=sys.stderr,
        )
        return 1

    session_id = sys.argv[1]
    json_file_path = sys.argv[2]

    update_linear_activity(
        session_id,
        "thought",
        "Antigravity has initialized locally and is analyzing the task.",
    )

    try:
        prompt_context = load_prompt(json_file_path)

        print("Dispatching task to Antigravity CLI...")
        agent_output = await run_antigravity(prompt_context)

        print(agent_output)

        update_linear_activity(
            session_id,
            "response",
            f"Task completed.\n\n{agent_output}",
        )

        return 0

    except Exception as error:
        error_message = f"{type(error).__name__}: {error}"
        print(f"Execution failure: {error_message}", file=sys.stderr)

        update_linear_activity(
            session_id,
            "error",
            f"Local execution failed.\n\n{error_message}",
        )

        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
