"""Read-only cross-check of operator-pinned memory jobs against canonical Bridge ledger."""
import hashlib
import json
import os
import pathlib
import stat

LEDGER = "/home/bridge/agent-bridge/linear-agent-bridge/linear-jobs/job-state"
ADMITTED = frozenset(("queued", "launching", "running", "waiting_quota",
                      "awaiting_external", "completed"))


def regular_json(path, limit=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= limit:
            return None
        content = os.read(fd, limit + 1)
        if not 0 < len(content) <= limit:
            return None
        return json.loads(content)
    finally:
        os.close(fd)


def admitted_job(manifest, record):
    """The root manifest is required but *never* proves a live admission alone."""
    try:
        if manifest.get("ledgerRoot") != LEDGER:
            return False
        key, job = record["jobKey"], record["trustedJob"]
        repo_roots = [root for root, repo in manifest["repositories"].items()
                      if repo == job["scope"]["repositoryId"]]
        if not repo_roots or not isinstance(key, str) or len(key) > 256:
            return False
        file = pathlib.Path(LEDGER) / hashlib.sha256(key.encode()).hexdigest() / "state.json"
        ledger = regular_json(str(file))
        if not isinstance(ledger, dict) or ledger.get("key") != key:
            return False
        agent = job["scope"]["agentId"]
        if (ledger.get("agent") != agent or ledger.get("jobId") != job["jobId"] or
            ledger.get("issueId") != job["scope"]["issueId"] or
            ledger.get("repositoryRoot") not in repo_roots or
            ledger.get("state") not in ADMITTED or
            key != agent + ":" + ledger.get("deliveryId", "")):
            return False
        task_path = ledger.get("taskFile")
        root = ledger["repositoryRoot"]
        if (not isinstance(task_path, str) or
            not task_path.startswith(root + "/.linear-agent/projects/") or
            not task_path.endswith(".json") or
            os.path.normpath(task_path) != task_path or
            "/../" in task_path):
            return False
        task = regular_json(task_path)
        if not isinstance(task, dict):
            return False
        issue = task.get("issueMetadata") or {}
        return (task.get("organizationId") == job["scope"]["tenantId"] and
                (task.get("issueId") or issue.get("id")) == job["scope"]["issueId"] and
                (task.get("agentSessionId") is None or
                 task.get("agentSessionId") == ledger.get("agentSessionId")))
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        return False
