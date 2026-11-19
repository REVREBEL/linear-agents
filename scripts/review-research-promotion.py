#!/usr/bin/env python3
"""Compile a reviewed research candidate into an inert Registry v2 proposal."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse
import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError, SchemaError

ROOT = Path(__file__).resolve().parents[1]
KIND = {("cli_agent", "headless_cli"): "cli_agent", ("llm", "direct_api"): "service_agent"}
TRANSPORT = {"headless_cli": "headless_cli", "direct_api": "api"}
AUTONOMY = {"Read-only": 0, "Recommender": 1, "Supervised": 1, "Executor": 2, "Autonomous": 2}
TARGET_AUTONOMY = {"Observer": 0, "Advisor": 1, "Executor": 2}
RISKS = {"Low": 0, "Medium": 1, "High": 2}
PERMISSIONS = {"sourceWrite", "directoryMoves", "gitCommit", "gitPush", "autoMerge", "deployment"}
REVIEW_KEYS = {"schemaVersion", "candidateId", "researchSha256", "approval", "verification", "bridge"}
BRIDGE_KEYS = {"role", "provider", "packageDir", "targetPackageDir", "worker",
               "linear", "execution", "profileKind", "runtimeContract", "executionPolicy"}


def refuse(message):
    raise ValueError(message)


def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != keys:
        refuse(f"{label}: invalid or missing fields")


def url(value, label):
    if not isinstance(value, str) or not value.startswith("https://"):
        refuse(f"{label}: verified HTTPS URL required")
    parsed = urlparse(value)
    if not parsed.hostname or parsed.hostname.endswith((".invalid", ".test", ".local")) or parsed.username:
        refuse(f"{label}: invalid evidence URL")


def safe_shell(value):
    if value is not None and (not isinstance(value, str) or not value.strip()
                              or re.search(r"[;&|$<>\x60\\\r\n]", value)):
        refuse("Unsafe research command template")


def safe_argv(argv):
    if not isinstance(argv, list) or not argv:
        refuse("Reviewed argv tokens required")
    for arg in argv:
        if arg in ("{{PROMPT}}", "{{CONVERSATION_ID}}"):
            continue
        if (not isinstance(arg, str) or not arg or re.search(r"[;&|$<>\x60\\\r\n]", arg)
                or "{{" in arg or "}}" in arg or (arg.startswith("-") and " " in arg)):
            refuse("Unsafe CLI argv tokens")


def safe_dir(root, value):
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._/-]+", value)
            or value.startswith("/") or ".." in Path(value).parts):
        refuse("Unsafe relative repo path")
    result = root / value
    if not result.is_dir() or not result.resolve().is_relative_to(root.resolve()):
        refuse("Missing/outside repository directory")
    return result


def jsonc(source):
    # Remove comments and trailing commas without altering quoted strings.
    output = []
    quoted = escaped = line = block = False
    i = 0
    while i < len(source):
        c, nxt = source[i], source[i+1] if i+1 < len(source) else ""
        if line:
            if c == "\n":
                line = False
                output.append("\n")
            i += 1
            continue
        if block:
            if c == "*" and nxt == "/":
                block = False
                i += 2
            else:
                i += 1
            continue
        if quoted:
            output.append(c)
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
            output.append(c)
        elif c == "/" and nxt == "/":
            line = True
            i += 2
            continue
        elif c == "/" and nxt == "*":
            block = True
            i += 2
            continue
        else:
            output.append(c)
        i += 1
    if quoted or block:
        refuse("Malformed Worker JSONC")
    source = "".join(output)
    result = []
    quoted = escaped = False
    for i, c in enumerate(source):
        if c == '"' and not escaped:
            quoted = not quoted
        if c == "\\" and quoted:
            escaped = not escaped
        else:
            escaped = False
        if c == "," and not quoted:
            j = i + 1
            while j < len(source) and source[j].isspace():
                j += 1
            if j < len(source) and source[j] in "]}":
                continue
        result.append(c)
    return json.loads("".join(result))


def verify_worker(root, target, record):
    w = target["worker"]
    worker_dir = safe_dir(root, w["directory"])
    config = worker_dir / w["config"]
    if config.is_symlink() or not config.is_file() or not config.resolve().is_relative_to(root.resolve()):
        refuse("Missing Worker config or unsafe symlink")
    payload = config.read_bytes()
    if hashlib.sha256(payload).hexdigest() != record["configSha256"]:
        refuse("Worker config digest differs from reviewed evidence")
    settings = jsonc(payload.decode("utf-8"))
    prefix = w["prefixEnv"]
    route = "linear-" + "$" + "{" + prefix + "}." + "$" + "{DOMAIN}"
    kv = "$" + "{" + w["kvEnv"] + "}"
    if settings.get("name") != w["serviceTemplate"] or w["deployedName"] != "linear-" + target["id"] + "-agent":
        refuse("Missing consistent Worker identity")
    if not any(x.get("pattern") == route and x.get("custom_domain") is True for x in settings.get("routes", [])):
        refuse("Worker route does not match source")
    if not any(x.get("binding") == "LINEAR_DATA" and x.get("id") == kv for x in settings.get("kv_namespaces", [])):
        refuse("Worker KV binding does not match source")
    if not any(x.get("name") == w["durableObject"] and x.get("class_name") == "DeliveryCoordinator"
               for x in settings.get("durable_objects", {}).get("bindings", [])):
        refuse("Worker Durable Object binding missing")
    return config.relative_to(root).as_posix()


def load_research(root, candidate_id):
    if not re.fullmatch(r"[a-z][a-z0-9-]+", candidate_id):
        refuse("Invalid candidate ID")
    folder = (root / "agents/profiles/candidates").resolve()
    path = (folder / (candidate_id + ".yaml")).resolve()
    if not path.is_relative_to(folder) or not path.is_file():
        refuse("Research candidate missing/outside catalog")
    research = yaml.safe_load(path.read_text(encoding="utf-8"))
    schema = json.loads((root / "templates/context/agent-profile.entry.schema.json").read_text())
    Draft202012Validator(schema).validate(research)
    catalog = yaml.safe_load((root / "agents/agent-registry.yaml").read_text())
    matches = [a for a in catalog["agents"] if a.get("id") == candidate_id]
    if research.get("id") != candidate_id or len(matches) != 1 or matches[0] != research:
        refuse("Research profile differs from canonical catalog")
    safe_shell(research.get("runtime", {}).get("commandTemplate"))
    return path, research


def propose(root, candidate_id, review):
    exact(review, REVIEW_KEYS, "Review")
    if review["schemaVersion"] != 1 or review["candidateId"] != candidate_id:
        refuse("Unrecognized review format or candidate")
    path, research = load_research(root, candidate_id)
    fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    if review["researchSha256"] != fingerprint:
        refuse("Research source changed after approval")
    approval = review["approval"]
    exact(approval, {"decision", "reviewer", "submittedBy", "reviewUrl"}, "Approval")
    if (approval["decision"] != "approved" or
            any(not isinstance(approval[k], str) or not approval[k].strip()
                for k in ("reviewer", "submittedBy")) or
            approval["reviewer"] == approval["submittedBy"]):
        refuse("Independent approval missing")
    if not re.fullmatch(r"https://github\.com/REVREBEL/linear-agents/pull/[1-9][0-9]*", approval["reviewUrl"]):
        refuse("Approval must reference a GitHub PR")
    checks = review["verification"]
    exact(checks, {"model", "runtime", "worker"}, "Verification")
    exact(checks["model"], {"modelId", "provider", "evidenceUrl"}, "Model evidence")
    exact(checks["runtime"], {"evidenceUrl"}, "Runtime evidence")
    exact(checks["worker"], {"workerHost", "tunnelHost", "configSha256", "evidenceUrl"}, "Worker evidence")
    for label in checks:
        url(checks[label]["evidenceUrl"], label)
    if checks["model"]["modelId"] != research.get("model") or checks["model"]["provider"] != research["provider"]:
        refuse("Model provider/ID not verified")
    if not re.fullmatch(r"[0-9a-f]{64}", checks["worker"]["configSha256"]):
        refuse("Worker digest is missing")
    bridge = review["bridge"]
    exact(bridge, BRIDGE_KEYS, "Bridge mapping")
    key = (research["kind"], research["runtime"]["transport"])
    if key not in KIND or bridge["profileKind"] != KIND[key]:
        refuse("Unsupported research kind/transport translation")
    runtime = copy.deepcopy(bridge["runtimeContract"])
    if runtime.get("transport") != TRANSPORT[key[1]]:
        refuse("Transport mapping not approved")
    if research["runtime"]["executionHost"] != "ubuntu_agent_server" or runtime.get("executionHost") != "bridge_service":
        refuse("Unsupported host mapping")
    if key[1] == "headless_cli":
        exe = runtime.get("executable")
        if not isinstance(exe, dict) or set(exe) != {"binaryEnv", "argv"} or not re.fullmatch(r"[A-Z][A-Z0-9_]*", exe["binaryEnv"]):
            refuse("Missing explicit reviewed CLI executable")
        safe_argv(exe["argv"])
    elif "executable" in runtime:
        refuse("API transport cannot add a CLI executable")
    if "quotaPolicy" in runtime or "sessionContinuityFlag" in runtime:
        refuse("Unverified retry/session continuation metadata")
    bindings = runtime.get("linearBridge")
    if not isinstance(bindings, dict):
        refuse("Missing Worker/Linear binding")
    for key_name in ("workerHost", "tunnelHost", "supportedEvents", "completionMode"):
        if bindings.get(key_name) != research["linearBridge"].get(key_name):
            refuse("Unverified Worker/Linear field: " + key_name)
    for field in ("workerHost", "tunnelHost"):
        actual = bindings[field]
        if checks["worker"][field] != actual or "." not in actual or actual.endswith((".invalid", ".test", ".local")):
            refuse("Unverified Worker endpoint: " + field)
    policy = copy.deepcopy(bridge["executionPolicy"])
    autonomy = TARGET_AUTONOMY.get(policy.get("autonomy_level"))
    source_autonomy = AUTONOMY.get(research["execution"]["autonomy_level"])
    if autonomy is None or source_autonomy is None or autonomy > source_autonomy:
        refuse("Unknown/escalated autonomy")
    if research["execution"]["memory_scope"] != "session_isolated" or policy.get("memory_scope") != "session_isolated":
        refuse("Memory scope needs separate review")
    permissions = policy.get("permissions")
    if not isinstance(permissions, dict) or set(permissions) != PERMISSIONS:
        refuse("Incomplete permission review")
    for name in PERMISSIONS:
        if type(permissions[name]) is not bool or permissions[name] and not research["permissions"][name]:
            refuse("Invalid/elevated permission: " + name)
    if any(permissions[name] for name in ("gitPush", "autoMerge", "deployment")):
        refuse("Privileged Git/deployment rights not promotable")
    srcsec, tgtsec = research["security"], policy.get("security")
    if not isinstance(tgtsec, dict) or srcsec["blast_radius"] not in RISKS or tgtsec.get("blast_radius") not in RISKS or RISKS[tgtsec["blast_radius"]] < RISKS[srcsec["blast_radius"]]:
        refuse("Risk classification missing/downgraded")
    if tgtsec.get("credential_model") not in ("none", "ephemeral_session"):
        refuse("Unverified service credentials")
    if srcsec["credential_model"] != "ephemeral_session" and tgtsec["credential_model"] != "none":
        refuse("Credential translation needs review")
    if not set(srcsec["envStripPatterns"]).issubset(set(tgtsec.get("envStripPatterns", []))):
        refuse("Security environment strip rules dropped")
    for label in ("mcpToolAllowlist", "handoff_targets"):
        if not set(tgtsec.get(label, [])).issubset(set(srcsec.get(label, []))):
            refuse("Unauthorized " + label)

    entry = {
        "id": research["id"], "role": bridge["role"], "provider": bridge["provider"],
        "packageDir": bridge["packageDir"], "worker": copy.deepcopy(bridge["worker"]),
        "execution": copy.deepcopy(bridge["execution"]), "linear": copy.deepcopy(bridge["linear"]),
        "profile": {
            "displayName": research["displayName"], "kind": bridge["profileKind"],
            "model": {"selection": "pinned", "id": checks["model"]["modelId"], "provider": checks["model"]["provider"]},
            "taxonomy": {"agent_type": research["taxonomy"]["agent_type"], "domain": research["taxonomy"]["domain"],
                         "top_skills": research["taxonomy"].get("top_skills", [])},
            "routing": {"complexity_tier": research["routing"]["complexity_tier"],
                        "semantic_description": research["routing"].get("semantic_description") or research["description"],
                        "supported_intents": research["routing"]["supported_intents"]},
        },
        "runtimeContract": runtime, "executionPolicy": policy, "targetPackageDir": bridge["targetPackageDir"],
    }
    schema = json.loads((root / "agents/registry.schema.json").read_text())
    Draft202012Validator({"$schema": "https://json-schema.org/draft/2020-12/schema",
                         "$defs": schema["$defs"], "$ref": "#/$defs/agent"}).validate(entry)
    safe_dir(root, entry["packageDir"])
    worker_path = verify_worker(root, entry, checks["worker"])
    current = json.loads((root / "agents/registry.json").read_text())
    if any(a["id"] == entry["id"] or a["worker"]["deployedName"] == entry["worker"]["deployedName"]
           or a["worker"]["directory"] == entry["worker"]["directory"] for a in current["agents"]):
        refuse("Agent or Worker identity already in the executable registry")
    return {
        "status": "reviewed-proposal-not-installed",
        "provenance": {"researchPath": path.relative_to(root).as_posix(), "researchSha256": fingerprint,
                       "researchDescription": research["description"], "approval": copy.deepcopy(approval),
                       "verification": copy.deepcopy(checks), "workerConfigPath": worker_path},
        "registryEntry": entry,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--candidate", required=True)
    p.add_argument("--review", type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(propose(ROOT, a.candidate, json.loads(a.review.read_text(encoding="utf-8"))), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, ValidationError, SchemaError) as error:
        print(f"Research promotion rejected: {error}", file=sys.stderr)
        sys.exit(2)
