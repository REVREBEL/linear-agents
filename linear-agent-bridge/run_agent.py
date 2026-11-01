#!/usr/bin/env python3

import asyncio
import json
import os
import sys
import re
from pathlib import Path
from collections import deque
from typing import Any

import requests


ANTIGRAVITY_BIN = os.path.expanduser(
    os.getenv("ANTIGRAVITY_BIN", "~/.local/bin/agy")
)
ANTIGRAVITY_PRINT_TIMEOUT = os.getenv("ANTIGRAVITY_PRINT_TIMEOUT", "30m")
ANTIGRAVITY_SETTINGS = os.getenv(
    "ANTIGRAVITY_SETTINGS",
    json.dumps({"permissions": {"allow": ["mcp(github/list_commits)"]}}),
)
ANTIGRAVITY_WORKSPACE = os.path.abspath(
    os.path.expanduser(
        os.getenv("ANTIGRAVITY_WORKSPACE", os.getcwd())
    )
)


def antigravity_subprocess_env() -> dict[str, str]:
    """Keep Linear app activity credentials out of the untrusted CLI child."""
    environment = os.environ.copy()
    environment.pop("LINEAR_API_KEY", None)
    environment.pop("LINEAR_ACCESS_TOKEN", None)
    environment.pop("BRIDGE_SHARED_SECRET", None)
    return environment


def post_worker_activity(
    session_id: str,
    completion_url: str,
    activity_type: str,
    message: str,
) -> bool:
    shared_secret = os.getenv("BRIDGE_SHARED_SECRET")

    if not completion_url or not shared_secret:
        print(
            "Missing completionUrl or BRIDGE_SHARED_SECRET; "
            "cannot send activity through the Worker.",
            file=sys.stderr,
        )
        return False

    try:
        response = requests.post(
            completion_url,
            headers={
                "Authorization": f"Bearer {shared_secret}",
                "Content-Type": "application/json",
            },
            json={
                "agentSessionId": session_id,
                "activityType": activity_type,
                "body": message,
            },
            timeout=20,
        )

        response.raise_for_status()
        body: dict[str, Any] = response.json()
        return bool(body.get("ok"))

    except Exception as error:
        print(
            f"Failed to emit activity through Worker: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return False


def load_job_context(json_file_path: str) -> tuple[str, str]:
    with open(json_file_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    prompt = data.get("payload", {}).get("data", {}).get("promptContext")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Missing payload.data.promptContext")
    completion_url = data.get("completionUrl") or data.get("payload", {}).get("data", {}).get("completionUrl")
    if not isinstance(completion_url, str) or not completion_url.strip():
        raise ValueError("Missing completionUrl")
    return prompt.strip(), completion_url.strip()


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


async def read_bounded_stderr(stream: asyncio.StreamReader, limit: int = 8192) -> str:
    """Drain stderr without buffering unlimited subprocess diagnostics."""
    tail = b""
    while chunk := await stream.read(4096):
        tail = (tail + chunk)[-limit:]
    return tail.decode("utf-8", errors="replace").strip()


async def run_antigravity(prompt: str, conversation_id: str | None = None) -> str:
    if not os.path.isfile(ANTIGRAVITY_BIN) or not os.access(ANTIGRAVITY_BIN, os.X_OK):
        raise FileNotFoundError(f"Antigravity CLI not executable: {ANTIGRAVITY_BIN}")
    if not os.path.isdir(ANTIGRAVITY_WORKSPACE):
        raise NotADirectoryError(ANTIGRAVITY_WORKSPACE)

    command = [
        ANTIGRAVITY_BIN, "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT, "--sandbox",
        "--settings", ANTIGRAVITY_SETTINGS,
    ]
    if conversation_id:
        command.extend(["--conversation", conversation_id])
    input_message = json.dumps(
        {"event": "user", "message": {"content": prompt}},
        ensure_ascii=False,
    ) + "\n"

    process = await asyncio.create_subprocess_exec(
        *command, cwd=ANTIGRAVITY_WORKSPACE, env=antigravity_subprocess_env(),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=1024 * 1024,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    stderr_task = asyncio.create_task(read_bounded_stderr(process.stderr))
    async def send_prompt():
        process.stdin.write(input_message.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()

    input_task = asyncio.create_task(send_prompt())
    stdout_lines = deque(maxlen=30)
    events = deque(maxlen=30)
    result = None
    announced_conversation_id = conversation_id
    async def stream_lines():
        # Read chunks rather than readline(), whose StreamReader limit rejects
        # large JSONL events. Cap malformed/unbounded individual events.
        pending = bytearray()
        while chunk := await process.stdout.read(65536):
            pending.extend(chunk)
            if len(pending) > 32 * 1024 * 1024 and b"\\n" not in pending:
                raise ValueError("AGY JSONL event exceeds 32 MiB")
            while b"\\n" in pending:
                index = pending.index(b"\\n")
                if index > 32 * 1024 * 1024:
                    raise ValueError("AGY JSONL event exceeds 32 MiB")
                yield bytes(pending[:index])
                del pending[:index + 1]
        if pending:
            yield bytes(pending)

    try:
        async for line_bytes in stream_lines():
            line = line_bytes.decode("utf-8", errors="replace").rstrip("\r\n")
            stdout_lines.append(line[-4000:])
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            events.append(event if len(line) <= 4000 else {"event": event.get("event"), "conversation_id": event.get("conversation_id")})
            observed_id = event_conversation_id([event])
            if observed_id and observed_id != announced_conversation_id:
                announced_conversation_id = observed_id
                print("AGY_BRIDGE_EVENT=" + json.dumps({
                    "event": "conversation_started",
                    "conversation_id": observed_id,
                }), flush=True)
            if event.get("event") == "result" and isinstance(event.get("result"), dict):
                result = event["result"]

        await input_task
    except BaseException:
        input_task.cancel()
        if process.returncode is None:
            process.kill()
        await process.wait()
        await asyncio.gather(input_task, stderr_task, return_exceptions=True)
        raise

    await process.wait()
    stderr = await stderr_task
    stdout = "\n".join(stdout_lines)

    # Never use -c or a workspace's "last conversation" in a multi-issue bridge.
    # Require the actual run to report its conversation ID.
    resolved_id = announced_conversation_id or event_conversation_id(list(events))
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
        recent_events = json.dumps(list(events)[-5:], ensure_ascii=False)[-2000:]
        raise RuntimeError(
            "Antigravity CLI completed without a response. "
            f"Recent events: {recent_events}"
        )
    return response.strip()


async def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: run_agent.py <agentSessionId> <jobPath> [conversationId]", file=sys.stderr)
        return 1
    session_id, json_file_path = sys.argv[1:3]
    resumed_conversation = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        prompt, completion_url = load_job_context(json_file_path)
        post_worker_activity(
            session_id,
            completion_url,
            "thought",
            "Antigravity has initialized locally and is analyzing the task.",
        )
        response = await run_antigravity(prompt, resumed_conversation)
        print(response)
        post_worker_activity(session_id, completion_url, "response", f"Task completed.\n\n{response}")
        return 0
    except QuotaExhausted as error:
        event = {"event": "on_exhaustion", "conversation_id": error.conversation_id}
        print("AGY_BRIDGE_EVENT=" + json.dumps(event), flush=True)
        post_worker_activity(session_id, completion_url, "thought", "Antigravity quota exhausted; a retry will be scheduled if the session can be identified.")
        return 75
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        print(f"Execution failure: {message}", file=sys.stderr)
        if "completion_url" in locals():
            post_worker_activity(session_id, completion_url, "error", f"Local execution failed.\n\n{message}")
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
