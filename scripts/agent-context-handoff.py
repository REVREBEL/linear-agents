#!/usr/bin/env python3
"""ABR-84 D5: create and verify source-linked, versioned context handoffs.

A handoff is a portable JSON artifact or a Markdown message carrying that
entire JSON artifact. It is data, not a runtime authorization or signature.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

import yaml
from context_contract import validate_relative_document_path
from context_resolver import resolve_context

VERSION = 1
BEGIN = "<!-- BEGIN AGENT-CONTEXT-HANDOFF/V1 -->"
END = "<!-- END AGENT-CONTEXT-HANDOFF/V1 -->"
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MAX_MESSAGE_BYTES = 256_000


def valid_repository(value):
    if not isinstance(value, str) or not REPOSITORY.fullmatch(value):
        return False
    return all(part not in (".", "..") and not part.startswith("-")
               for part in value.split("/"))
MAX_HANDOFF_BYTES = 2_000_000


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def hash_object(value):
    return digest(canonical(value))


def git(root, *arguments):
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise ValueError(
            "Cannot inspect pinned source revision: "
            + result.stderr.decode("utf-8", "replace").strip()
        )
    return result.stdout


def create_handoff(repo_root, repository, message, *, topic=None, path=None,
                   files_changed=False, allow_partial=False, environ=None):
    if not valid_repository(repository):
        raise ValueError("Repository must be a portable owner/name identifier")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Handoff message must be nonempty")
    if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError("Handoff message exceeds maximum size")
    if BEGIN in message or END in message:
        raise ValueError("Handoff message contains reserved envelope markers")
    bundle = resolve_context(
        repo_root, topic=topic, path=path, files_changed=files_changed,
        allow_partial=allow_partial, environ=environ,
    )
    validate_bundle(bundle, allow_partial=allow_partial)
    envelope = {
        "handoffVersion": VERSION,
        "repository": repository,
        "repoCommit": bundle["gitHeadSha"],
        "contextBundle": bundle,
        "contextSha256": hash_object(bundle),
        "message": message,
        "messageSha256": digest(message.encode("utf-8")),
    }
    envelope["handoffSha256"] = hash_object(envelope)
    if len(canonical(envelope)) > MAX_HANDOFF_BYTES:
        raise ValueError("Context handoff exceeds maximum size")
    return envelope


def validate_bundle(bundle, *, allow_partial=False):
    if not isinstance(bundle, dict) or set(bundle) != {
        "contextVersion", "project", "gitHeadSha", "selection",
        "unmatchedPaths", "partial", "missingDocuments", "documents",
    }:
        raise ValueError("Malformed context bundle shape")
    if not isinstance(bundle["contextVersion"], int) or bundle["contextVersion"] < 1:
        raise ValueError("Invalid context version")
    if not isinstance(bundle["project"], str) or not bundle["project"].strip():
        raise ValueError("Missing context project")
    if not SHA.fullmatch(bundle["gitHeadSha"]):
        raise ValueError("Malformed pinned Git HEAD")
    if (not isinstance(bundle["selection"], dict)
            or set(bundle["selection"]) != {"mode", "value"}
            or bundle["selection"]["mode"] not in
            {"default", "topic", "path", "files-changed"}):
        raise ValueError("Missing context selection provenance")
    if not isinstance(bundle["unmatchedPaths"], list) or not all(
        isinstance(x, str) for x in bundle["unmatchedPaths"]
    ):
        raise ValueError("Invalid unmatched path evidence")
    if type(bundle["partial"]) is not bool:
        raise ValueError("Context partial flag must be boolean")
    if not isinstance(bundle["documents"], list) or not bundle["documents"]:
        raise ValueError("Handoff must include full context documents")
    if not isinstance(bundle["missingDocuments"], list):
        raise ValueError("Malformed missing-documents list")
    if bundle["partial"] != bool(bundle["missingDocuments"]):
        raise ValueError("Contradictory partial-context status")
    if bundle["partial"] and not allow_partial:
        raise ValueError("Incomplete context handoff requires explicit --allow-partial")
    seen = set()
    for item in bundle["documents"]:
        required = {
            "id", "title", "root", "sourcePath", "gitSourcePath",
            "gitSha", "gitHeadSha", "sha256", "worktreeModified",
            "requires", "reasons", "content",
        }
        if not isinstance(item, dict) or set(item) != required:
            raise ValueError("Handoff README content or provenance is missing")
        doc_id = item["id"]
        if not isinstance(doc_id, str) or not doc_id or doc_id in seen:
            raise ValueError("Duplicate or invalid context document ID")
        seen.add(doc_id)
        if not all(isinstance(item[k], str) and item[k] for k in (
            "title", "root", "sourcePath", "gitSourcePath", "content",
        )):
            raise ValueError("Malformed document source reference")
        validate_relative_document_path(item["gitSourcePath"])
        if not SHA.fullmatch(item["gitSha"]) or item["gitHeadSha"] != bundle["gitHeadSha"]:
            raise ValueError("Document Git provenance differs from pinned context")
        if type(item["worktreeModified"]) is not bool or item["worktreeModified"]:
            raise ValueError("Uncommitted README content cannot be a reproducible handoff")
        if not DIGEST.fullmatch(item["sha256"]) or digest(
            item["content"].encode("utf-8")
        ) != item["sha256"]:
            raise ValueError("Document content hash mismatch")
        if not isinstance(item["requires"], list) or not all(
            isinstance(s, str) and s for s in item["requires"]
        ) or item["requires"] != sorted(set(item["requires"])):
            raise ValueError("Invalid dependency provenance")
        if not isinstance(item["reasons"], list) or not item["reasons"] or not all(
            isinstance(s, str) and s for s in item["reasons"]
        ):
            raise ValueError("Missing document inclusion reasons")
    for item in bundle["missingDocuments"]:
        if not isinstance(item, dict) or set(item) != {
            "id", "root", "sourcePath", "reasons", "error"
        } or not all(isinstance(item[k], str) and item[k] for k in (
            "id", "root", "sourcePath", "error",
        )) or not isinstance(item["reasons"], list) or not item["reasons"]:
            raise ValueError("Invalid explicit missing-document metadata")
        if item["id"] in seen:
            raise ValueError("Document cannot be present and missing")
        seen.add(item["id"])
    positions = {
        item["id"]: n for n, item in enumerate(bundle["documents"])
    }
    for item in bundle["documents"]:
        for required in item["requires"]:
            if required not in seen:
                raise ValueError("Unresolved context dependency: " + required)
            if required in positions and positions[required] >= positions[item["id"]]:
                raise ValueError("Context documents are not dependency-first")


def verify_handoff(envelope, *, allow_partial=False, repo_root=None,
                   check_source=False):
    fields = {
        "handoffVersion", "repository", "repoCommit", "contextBundle",
        "contextSha256", "message", "messageSha256", "handoffSha256",
    }
    if not isinstance(envelope, dict) or set(envelope) != fields:
        raise ValueError("Invalid versioned handoff envelope")
    if type(envelope["handoffVersion"]) is not int or envelope["handoffVersion"] != VERSION:
        raise ValueError("Unsupported handoff contract version")
    if not valid_repository(envelope["repository"]):
        raise ValueError("Invalid source repository identity")
    if not SHA.fullmatch(envelope["repoCommit"]):
        raise ValueError("Missing source-linked Git commit")
    if not isinstance(envelope["message"], str) or not envelope["message"].strip():
        raise ValueError("Missing handoff message")
    if len(envelope["message"].encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError("Handoff message exceeds maximum size")
    if BEGIN in envelope["message"] or END in envelope["message"]:
        raise ValueError("Reserved handoff delimiter injected into message")
    if len(canonical(envelope)) > MAX_HANDOFF_BYTES:
        raise ValueError("Context handoff exceeds maximum size")
    validate_bundle(envelope["contextBundle"], allow_partial=allow_partial)
    if envelope["repoCommit"] != envelope["contextBundle"]["gitHeadSha"]:
        raise ValueError("Handoff pinned revision differs from context revision")
    if (not DIGEST.fullmatch(envelope["contextSha256"])
            or envelope["contextSha256"] != hash_object(envelope["contextBundle"])):
        raise ValueError("Context bundle integrity hash mismatch")
    if (not DIGEST.fullmatch(envelope["messageSha256"])
            or envelope["messageSha256"] != digest(envelope["message"].encode("utf-8"))):
        raise ValueError("Message integrity hash mismatch")
    self_hash = envelope["handoffSha256"]
    if not DIGEST.fullmatch(self_hash) or self_hash != hash_object({
        k: v for k, v in envelope.items() if k != "handoffSha256"
    }):
        raise ValueError("Handoff integrity hash mismatch")
    if check_source:
        if repo_root is None:
            raise ValueError("Pinned Git source verification requires --repo-root")
        root = Path(repo_root).resolve()
        commit = envelope["repoCommit"]
        expected_commit = git(root, "rev-parse", "--verify", commit + "^{commit}").decode().strip()
        if expected_commit != commit:
            raise ValueError("Pinned Git commit unavailable")
        manifest = yaml.safe_load(git(root, "show", commit + ":.agents/context.yaml"))
        bundle = envelope["contextBundle"]
        if manifest["contextVersion"] != bundle["contextVersion"] or manifest["project"] != bundle["project"]:
            raise ValueError("Pinned context manifest version/project mismatch")
        for item in bundle["documents"]:
            origin = manifest["documents"].get(item["id"])
            if origin is None or origin["root"] != item["root"]:
                raise ValueError("Pinned manifest does not own context ID: " + item["id"])
            if item["root"] == "repo":
                expected = origin["path"]
            else:
                # Host README bytes are linked to committed managed templates,
                # not to a private /opt runtime root on the original host.
                from context_contract import HOST_SOURCE_DOCS
                expected = HOST_SOURCE_DOCS.get(item["id"])
            if item["gitSourcePath"] != expected:
                raise ValueError("Pinned Git source path does not match context manifest")
            raw = git(root, "show", commit + ":" + expected)
            if raw != item["content"].encode("utf-8"):
                raise ValueError("Pinned Git source bytes do not match handoff content")
            source = raw.decode("utf-8")
            if not source.startswith("---\\n") or "\\n---\\n" not in source[4:]:
                raise ValueError("Pinned source frontmatter missing")
            declared = yaml.safe_load(source[4:].split("\\n---\\n", 1)[0])
            metadata = declared.get("context") if isinstance(declared, dict) else None
            if (not isinstance(metadata, dict)
                    or metadata.get("id") != item["id"]
                    or metadata.get("title") != item["title"]
                    or sorted(metadata.get("requires", [])) != item["requires"]):
                raise ValueError("Pinned source metadata differs from handoff dependencies")
            source_commit = git(
                root, "log", "-1", "--format=%H", commit, "--", expected
            ).decode("ascii").strip()
            if source_commit != item["gitSha"]:
                raise ValueError("Pinned source revision mismatch")
        for missing in bundle["missingDocuments"]:
            missing_id = missing["id"]
            origin = manifest["documents"].get(missing_id)
            if (origin is None or origin["root"] == "repo"
                    or manifest["roots"][origin["root"]]["required"]):
                raise ValueError("Missing context entry is not an optional host source")
    return envelope


def render_markdown(envelope):
    return (
        "# Agent handoff (source-linked context v1)\n\n"
        + envelope["message"].rstrip() + "\n\n"
        + BEGIN + "\n"
        + chr(96) * 3 + "json\n"
        + json.dumps(envelope, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        + chr(96) * 3 + "\n"
        + END + "\n"
    )


def parse_handoff(source):
    if len(source.encode("utf-8")) > MAX_HANDOFF_BYTES * 2:
        raise ValueError("Handoff input exceeds maximum size")
    if source.count(BEGIN) == 1 and source.count(END) == 1:
        before, rest = source.split(BEGIN)
        data, after = rest.split(END)
        fence = chr(96) * 3
        data = data.strip()
        if not (data.startswith(fence + "json\n") and data.endswith("\n" + fence)):
            raise ValueError("Malformed Markdown handoff JSON block")
        obj = json.loads(data[len(fence + "json\n"):-len("\n" + fence)])
        if render_markdown(obj) != source:
            raise ValueError("Rendered message differs from versioned handoff envelope")
        return obj
    if BEGIN in source or END in source:
        raise ValueError("Incomplete or duplicate handoff markers")
    return json.loads(source)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="produce complete context handoff")
    create.add_argument("--repo-root", type=Path, default=Path.cwd())
    create.add_argument("--repository", required=True, help="owner/repo identity")
    create.add_argument("--message-file", type=Path, required=True)
    group = create.add_mutually_exclusive_group()
    group.add_argument("--topic")
    group.add_argument("--path")
    group.add_argument("--files-changed", action="store_true")
    create.add_argument("--allow-partial", action="store_true")
    create.add_argument("--format", choices=("markdown", "json"), default="markdown")
    create.add_argument("--output", type=Path)
    verify = commands.add_parser("verify", help="validate saved/received handoff")
    verify.add_argument("--input", type=Path, required=True)
    verify.add_argument("--repo-root", type=Path)
    verify.add_argument("--check-source", action="store_true")
    verify.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            message = args.message_file.read_text(encoding="utf-8")
            result = create_handoff(
                args.repo_root, args.repository, message, topic=args.topic,
                path=args.path, files_changed=args.files_changed,
                allow_partial=args.allow_partial,
            )
            output = render_markdown(result) if args.format == "markdown" else (
                json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
            )
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(output, encoding="utf-8")
            else:
                sys.stdout.write(output)
        else:
            source = args.input.read_text(encoding="utf-8")
            envelope = parse_handoff(source)
            verify_handoff(
                envelope, allow_partial=args.allow_partial,
                repo_root=args.repo_root, check_source=args.check_source,
            )
            print(
                "Verified handoff v1: "
                + envelope["contextSha256"] + " "
                + envelope["repoCommit"] + " "
                + str(len(envelope["contextBundle"]["documents"])) + " README sources"
            )
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print("Context handoff invalid: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
