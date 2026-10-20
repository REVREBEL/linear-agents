#!/usr/bin/env python3

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict


app = FastAPI(title="Linear Agent Bridge")

SECRET_TOKEN = os.environ["BRIDGE_SHARED_SECRET"]
AGY_BIN = Path(
    os.environ.get("AGY_BIN", str(Path.home() / ".local" / "bin" / "agy"))
).expanduser().resolve()
AGY_PRINT_TIMEOUT = os.environ.get("AGY_PRINT_TIMEOUT", "30m")

WORKSPACE = Path(
    os.environ.get(
        "AGENT_WORKSPACE",
        str(Path.home() / "Projects" / "REBEL-APP"),
    )
).expanduser().resolve()

# Prevent two agents from writing to the same repository simultaneously.
agent_lock = asyncio.Lock()

# Keep references so background tasks are not garbage-collected.
running_tasks: set[asyncio.Task[Any]] = set()


class LinearData(BaseModel):
    model_config = ConfigDict(extra="allow")

    promptContext: str


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")

    data: LinearData


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    source: str
    payload: Payload


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "agent-fastapi-bridge",
        "workspace": str(WORKSPACE),
        "workspaceExists": WORKSPACE.is_dir(),
        "jobsRunning": len(running_tasks),
    }


@app.post("/jobs", status_code=202)
async def handle_inbound_job(
    job: JobRequest,
    authorization: str | None = Header(default=None),
    x_linear_webhook_id: str | None = Header(default=None),
) -> dict[str, Any]:
    if authorization != f"Bearer {SECRET_TOKEN}":
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing Authorization token",
        )

    if not WORKSPACE.is_dir():
        raise HTTPException(
            status_code=500,
            detail=f"Workspace does not exist: {WORKSPACE}",
        )

    job_id = x_linear_webhook_id or os.urandom(8).hex()
    prompt = build_prompt(job.payload.data.promptContext)

    task = asyncio.create_task(
        execute_agent_job(
            job_id=job_id,
            prompt=prompt,
        )
    )

    running_tasks.add(task)
    task.add_done_callback(running_tasks.discard)

    print(f"Accepted job: {job_id}")
    print(f"Source: {job.source}")

    return {
        "ok": True,
        "accepted": True,
        "jobId": job_id,
    }


def build_prompt(prompt_context: str) -> str:
    return f"""
You are handling a software-development task delegated from Linear.

Repository workspace:

{WORKSPACE}

Task context:

{prompt_context}

Requirements:

1. Work only within the repository workspace.
2. Inspect the existing code before modifying files.
3. Follow the repository's existing conventions.
4. Do not expose credentials or secrets.
5. Run relevant tests, linting, or type checks.
6. Do not claim success if validation fails.
7. Finish with a concise summary of:
   - work completed,
   - files changed,
   - tests or checks run,
   - anything requiring human review.
""".strip()


async def run_antigravity(prompt: str) -> str:
    """Run one Antigravity CLI turn using cached local authentication."""
    if not AGY_BIN.is_file() or not os.access(AGY_BIN, os.X_OK):
        raise FileNotFoundError(f"Antigravity CLI is not executable: {AGY_BIN}")

    command = [
        str(AGY_BIN),
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
        cwd=WORKSPACE,
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


async def execute_agent_job(
    job_id: str,
    prompt: str,
) -> None:
    async with agent_lock:
        previous_directory = Path.cwd()

        try:
            os.chdir(WORKSPACE)

            print(f"Starting Agent job: {job_id}")
            print(f"Workspace: {WORKSPACE}")

            result = await run_antigravity(prompt)

            print(f"Job completed: {job_id}")
            print(result)

        except Exception as error:
            print(f"Job failed: {job_id}")
            print(f"{type(error).__name__}: {error}")

        finally:
            os.chdir(previous_directory)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8788,
    )
