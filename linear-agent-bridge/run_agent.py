#!/usr/bin/env python3

import asyncio
import json
import os
import sys
import re
import time
from pathlib import Path
from collections import deque
from typing import Any

import requests


ANTIGRAVITY_BIN = os.path.expanduser(
    os.getenv("ANTIGRAVITY_BIN", "~/.local/bin/agy")
)
ANTIGRAVITY_PRINT_TIMEOUT = os.getenv("ANTIGRAVITY_PRINT_TIMEOUT", "30m")
ANTIGRAVITY_PROGRESS_INTERVAL_SECS = float(
    os.getenv("AGY_PROGRESS_INTERVAL_SECS", os.getenv("ANTIGRAVITY_PROGRESS_INTERVAL_SECS", "10"))
)
ANTIGRAVITY_SETTINGS = os.getenv("ANTIGRAVITY_SETTINGS", "").strip()
ANTIGRAVITY_SANDBOX = os.getenv("ANTIGRAVITY_SANDBOX", "false").strip().lower() in ("1", "true", "yes")
ANTIGRAVITY_MODE = os.getenv("ANTIGRAVITY_MODE", "cli").strip().lower()
ANTIGRAVITY_DESKTOP_APP = os.getenv("ANTIGRAVITY_DESKTOP_APP", "Antigravity").strip()
ANTIGRAVITY_WORKSPACE = os.path.abspath(
    os.path.expanduser(
        os.getenv("ANTIGRAVITY_WORKSPACE", os.getcwd())
    )
)


def extract_tool_info(step: dict) -> tuple[str, dict]:
    """Extract tool name and normalized parameters dict across all AGY schemas."""
    tool_name = str(
        step.get("tool_name")
        or step.get("tool")
        or step.get("name")
        or ""
    ).strip()
    params = {}

    # 1. tool_info (AGY stream-json standard)
    tool_info = step.get("tool_info")
    if isinstance(tool_info, dict):
        if not tool_name:
            tool_name = str(tool_info.get("name") or tool_info.get("tool_name") or "").strip()
        raw_params = tool_info.get("parameters") or tool_info.get("args") or tool_info.get("arguments") or {}
        if isinstance(raw_params, dict):
            params.update(raw_params)
        elif isinstance(raw_params, str):
            try:
                parsed = json.loads(raw_params)
                if isinstance(parsed, dict):
                    params.update(parsed)
            except Exception:
                pass

    # 2. tool_calls list (transcript and OpenAI format)
    tool_calls = step.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        first = tool_calls[0]
        if isinstance(first, dict):
            if not tool_name:
                tool_name = str(
                    first.get("name")
                    or first.get("tool_name")
                    or first.get("function", {}).get("name")
                    or ""
                ).strip()
            raw_args = (
                first.get("args")
                or first.get("arguments")
                or first.get("parameters")
                or first.get("function", {}).get("arguments")
                or {}
            )
            if isinstance(raw_args, dict):
                params.update(raw_args)
            elif isinstance(raw_args, str):
                try:
                    parsed = json.loads(raw_args)
                    if isinstance(parsed, dict):
                        params.update(parsed)
                except Exception:
                    pass

    # 3. Direct step attributes (tool_args, args, parameters)
    for key in ("tool_args", "args", "parameters", "arguments"):
        raw = step.get(key)
        if isinstance(raw, dict):
            params.update(raw)
        elif isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    params.update(parsed)
            except Exception:
                pass

    # Clean string values (strip surrounding quotes if duplicated)
    cleaned_params = {}
    for k, v in params.items():
        if isinstance(v, str):
            v_str = v.strip()
            if (v_str.startswith('"') and v_str.endswith('"')) or (v_str.startswith("'") and v_str.endswith("'")):
                v_str = v_str[1:-1].strip()
            cleaned_params[k] = v_str
        else:
            cleaned_params[k] = v

    return tool_name, cleaned_params


def format_step_summary(step: dict, workspace: str = "") -> str:
    """Format a human-readable, highly detailed progress summary for Linear."""
    step_type = str(step.get("step_type") or "").strip()
    tool_name, tool_args = extract_tool_info(step)

    # Clean summary / toolSummary if provided by agent
    summary = step.get("summary") or tool_args.get("toolSummary") or tool_args.get("summary")
    clean_sum = ""
    if isinstance(summary, str) and summary.strip():
        clean_sum = summary.strip().strip('"\'')

    # 1. Shell commands (run_command, bash, exec)
    if tool_name in ("run_command", "bash", "exec"):
        cmd = str(tool_args.get("CommandLine") or tool_args.get("command") or tool_args.get("cmd") or "").strip()
        if (cmd.startswith('"') and cmd.endswith('"')) or (cmd.startswith("'") and cmd.endswith("'")):
            cmd = cmd[1:-1].strip()

        cmd_display = cmd
        if len(cmd_display) > 65:
            cmd_display = cmd_display[:62] + "..."

        if clean_sum and cmd_display:
            if clean_sum.lower() in cmd_display.lower():
                return f"Running: `{cmd_display}`"
            return f"Running: {clean_sum} (`{cmd_display}`)"
        if clean_sum:
            return f"Running: {clean_sum}"
        if cmd_display:
            return f"Running command: `{cmd_display}`"
        return "Running terminal command"

    # 2. File reads
    if tool_name in ("read_file", "view_file"):
        path_val = str(tool_args.get("Path") or tool_args.get("path") or tool_args.get("file_path") or tool_args.get("file") or "").strip()
        if path_val:
            if workspace and path_val.startswith(workspace):
                rel = os.path.relpath(path_val, workspace)
            else:
                rel = os.path.basename(path_val) or path_val
            start_l = tool_args.get("StartLine")
            end_l = tool_args.get("EndLine")
            if start_l and end_l:
                return f"Reading `{rel}` (lines {start_l}-{end_l})"
            return f"Reading `{rel}`"
        return "Reading file"

    # 3. File edits / writes
    if tool_name in ("edit_file", "write_file", "replace_file_content", "multi_replace_file_content", "sed_file", "write_to_file"):
        path_val = str(tool_args.get("Path") or tool_args.get("path") or tool_args.get("file_path") or tool_args.get("file") or "").strip()
        if path_val:
            if workspace and path_val.startswith(workspace):
                rel = os.path.relpath(path_val, workspace)
            else:
                rel = os.path.basename(path_val) or path_val
            action = "Editing" if "edit" in tool_name or "replace" in tool_name or "sed" in tool_name else "Writing"
            return f"{action} `{rel}`"
        return f"File operation ({tool_name})"

    # 4. Background tasks management (manage_task)
    if tool_name == "manage_task":
        action = str(tool_args.get("Action") or tool_args.get("action") or "").strip()
        task_id = str(tool_args.get("TaskId") or tool_args.get("taskId") or "").strip()
        short_id = task_id.split("/")[-1] if "/" in task_id else task_id
        if action == "list":
            return "Listing background tasks"
        if action == "status":
            return f"Checking background task status ({short_id or 'all'})"
        if action == "kill":
            return f"Cancelling background task ({short_id or 'active'})"
        if action == "send_input":
            return f"Sending input to background task ({short_id})"
        if action:
            return f"Task manager: {action}"
        return "Managing background tasks"

    # 5. MCP tool calls (call_mcp_tool)
    if tool_name == "call_mcp_tool":
        server = str(tool_args.get("ServerName") or tool_args.get("server") or "").strip()
        mcp_tool = str(tool_args.get("ToolName") or tool_args.get("tool") or "").strip()
        if server.startswith("linear"):
            return f"Calling Linear MCP: `{mcp_tool or server}`"
        if server == "github":
            return f"Calling GitHub MCP: `{mcp_tool or server}`"
        if server and mcp_tool:
            return f"Calling MCP: `{server}/{mcp_tool}`"
        if mcp_tool:
            return f"Calling MCP tool: `{mcp_tool}`"
        return "Calling MCP tool"

    # 6. Web searches
    if tool_name in ("search_web", "web_search"):
        query = str(tool_args.get("query") or "").strip()
        if query:
            if len(query) > 60:
                query = query[:57] + "..."
            return f'Searching web for "{query}"'
        return "Searching the web"

    # 7. Code search / navigation (grep_search, find_by_name, list_dir)
    if tool_name == "grep_search":
        query = str(tool_args.get("query") or "").strip()
        return f'Searching codebase for "{query}"' if query else "Searching codebase"
    if tool_name == "find_by_name":
        pattern = str(tool_args.get("pattern") or "").strip()
        return f'Finding files matching "{pattern}"' if pattern else "Finding files"
    if tool_name == "list_dir":
        dir_path = str(tool_args.get("dir_path") or tool_args.get("path") or "").strip()
        if dir_path:
            rel = os.path.relpath(dir_path, workspace) if (workspace and dir_path.startswith(workspace)) else os.path.basename(dir_path) or dir_path
            return f"Listing directory `{rel}`"
        return "Listing directory"

    # 8. Subagent invocations & messaging
    if tool_name in ("invoke_subagent", "define_subagent"):
        role = str(tool_args.get("Role") or tool_args.get("TypeName") or tool_args.get("Name") or "subagent").strip()
        return f"Invoking subagent: {role}"
    if tool_name == "send_message":
        recip = str(tool_args.get("Recipient") or "agent").strip()
        return f"Messaging subagent ({recip})"
    if tool_name == "manage_subagents":
        action = str(tool_args.get("Action") or "status").strip()
        return f"Managing subagents ({action})"

    # 9. Generic tool fallback
    if tool_name:
        safe_tool = tool_name if re.fullmatch(r"[a-zA-Z0-9_.-]{1,60}", tool_name) else "tool"
        return f"Executing {safe_tool}"

    # 10. Agent thought or text generation
    thinking = str(step.get("thinking") or "").strip()
    if thinking:
        first_line = thinking.splitlines()[0].strip().lstrip("#*- ")
        if len(first_line) > 60:
            first_line = first_line[:57] + "..."
        return f"Reasoning: {first_line}"

    if step_type in ("agent_response", "PLANNER_RESPONSE"):
        return "Generating response..."

    if step_type in ("thought", "plan"):
        return "Analyzing repository and planning next steps"

    return "Working on task..."


def open_desktop_workspace(workspace: str) -> bool:
    """Launch or focus Antigravity Desktop on the target workspace in desktop mode."""
    if ANTIGRAVITY_MODE != "desktop":
        return False
    if not sys.platform.startswith("darwin"):
        return False
    try:
        import subprocess
        subprocess.run(
            ["open", "-a", ANTIGRAVITY_DESKTOP_APP, workspace],
            check=False,
            capture_output=True,
        )
        return True
    except Exception as error:
        print(f"Warning: Failed to launch Antigravity Desktop: {error}", file=sys.stderr)
        return False


def antigravity_subprocess_env() -> dict[str, str]:
    """Keep Linear app activity credentials out of the untrusted CLI child."""
    environment = os.environ.copy()
    environment.pop("LINEAR_API_KEY", None)
    environment.pop("LINEAR_ACCESS_TOKEN", None)
    environment.pop("BRIDGE_SHARED_SECRET", None)

    app_name = (
        os.getenv("ANTIGRAVITY_GITHUB_APP_NAME")
        or os.getenv("GITHUB_APP_NAME")
        or "rebel-antigravity"
    ).strip()
    app_id = (
        os.getenv("ANTIGRAVITY_GITHUB_APP_ID")
        or os.getenv("GITHUB_APP_ID")
        or "5411353"
    ).strip()

    if app_name and app_id:
        bot_name = f"{app_name}[bot]"
        bot_email = f"{app_id}+{app_name}[bot]@users.noreply.github.com"
        environment.setdefault("GIT_AUTHOR_NAME", bot_name)
        environment.setdefault("GIT_AUTHOR_EMAIL", bot_email)
        environment.setdefault("GIT_COMMITTER_NAME", bot_name)
        environment.setdefault("GIT_COMMITTER_EMAIL", bot_email)

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


async def run_antigravity(
    prompt: str,
    conversation_id: str | None = None,
    progress_callback=None,
) -> str:
    if not os.path.isfile(ANTIGRAVITY_BIN) or not os.access(ANTIGRAVITY_BIN, os.X_OK):
        raise FileNotFoundError(f"Antigravity CLI not executable: {ANTIGRAVITY_BIN}")
    if not os.path.isdir(ANTIGRAVITY_WORKSPACE):
        raise NotADirectoryError(ANTIGRAVITY_WORKSPACE)

    open_desktop_workspace(ANTIGRAVITY_WORKSPACE)

    command = [
        ANTIGRAVITY_BIN,
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT,
    ]
    if ANTIGRAVITY_SANDBOX:
        command.append("--sandbox")
    if ANTIGRAVITY_SETTINGS:
        command.extend(["--settings", ANTIGRAVITY_SETTINGS])
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
    last_progress_at = 0.0
    last_step_reported = -1
    last_reported_summary = ""
    progress_tasks = set()

    async def announce_progress(message: str):
        if progress_callback is None:
            return
        task = asyncio.create_task(asyncio.to_thread(progress_callback, message))
        progress_tasks.add(task)
        task.add_done_callback(progress_tasks.discard)
    async def stream_lines():
        # Read chunks rather than readline(), whose StreamReader limit rejects
        # large JSONL events. Cap malformed/unbounded individual events.
        pending = bytearray()
        while chunk := await process.stdout.read(65536):
            pending.extend(chunk)
            if len(pending) > 32 * 1024 * 1024 and b"\n" not in pending:
                raise ValueError("AGY JSONL event exceeds 32 MiB")
            while b"\n" in pending:
                index = pending.index(b"\n")
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
            if event.get("event") == "step_update":
                step = event.get("step_update") or {}
                index = step.get("step_index")
                state = step.get("state")
                now = time.monotonic()
                if isinstance(index, int) and state == "ACTIVE":
                    summary = format_step_summary(step, ANTIGRAVITY_WORKSPACE)
                    if summary and summary != last_reported_summary and (now - last_progress_at >= ANTIGRAVITY_PROGRESS_INTERVAL_SECS or index > last_step_reported + 1):
                        last_step_reported = index
                        last_progress_at = now
                        last_reported_summary = summary
                        await announce_progress(summary)
                        # Local bridge checkpoint: metadata only, never the raw
                        # model output, command text or tool parameters.
                        tool_name, _ = extract_tool_info(step)
                        safe_tool = tool_name if re.fullmatch(r"[A-Za-z0-9_.-]{1,60}", tool_name) else "unknown"
                        print("AGY_BRIDGE_EVENT=" + json.dumps({
                            "event": "progress",
                            "summary": f"Step {index}: {safe_tool}",
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
    if progress_tasks:
        await asyncio.gather(*progress_tasks, return_exceptions=True)
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
    denied_actions = result.get("denied_actions") if isinstance(result, dict) else None
    if denied_actions and isinstance(denied_actions, list) and len(denied_actions) > 0:
        denied_summaries = []
        for action in denied_actions:
            if isinstance(action, dict):
                act_type = action.get("action", "action")
                disp = action.get("display_name") or action.get("tool_name") or action.get("name") or "unspecified"
                denied_summaries.append(f"{act_type}: {disp}")
            else:
                denied_summaries.append(str(action))
        summary_str = ", ".join(denied_summaries)
        raise RuntimeError(
            f"Antigravity execution BLOCKED: Tool permissions were denied ({summary_str}). "
            "Please check settings.json or project permissions."
        )

    response = result.get("response") if isinstance(result, dict) else ""
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
        response = await run_antigravity(
            prompt, resumed_conversation,
            progress_callback=lambda message: post_worker_activity(session_id, completion_url, "thought", message),
        )
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
