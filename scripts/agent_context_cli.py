#!/usr/bin/env python3
"""Portable Agent Context CLI bootstrap (C2).

C2 exposes metadata validation and a stable CLI entrypoint. Document selection,
dependency retrieval, rendering formats and handoff bundles are implemented in
C3–C5; this executable must not infer execution permission from README text.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys

import yaml
from jsonschema.exceptions import SchemaError

from context_contract import validate_context_contract
from context_resolver import render_context, resolve_context

CLI_VERSION = "0.2.0"


def find_repo_root(explicit=None, *, cwd=None, environ=None):
    """Select the requested repository, or discover it from the working tree."""
    env = os.environ if environ is None else environ
    requested = explicit if explicit is not None else env.get("AGENT_CONTEXT_REPO_ROOT")
    if requested is not None:
        if not isinstance(requested, str) or not requested.strip():
            raise ValueError("AGENT_CONTEXT_REPO_ROOT/--repo-root must be a nonempty path")
        candidate = Path(requested).expanduser().resolve()
        if not candidate.is_dir():
            raise ValueError(f"Context project root does not exist: {candidate}")
        if not (candidate / ".agents/context.yaml").is_file():
            raise ValueError(f"Context manifest missing under project root: {candidate}")
        return candidate

    start = Path.cwd() if cwd is None else Path(cwd)
    if not start.is_dir():
        raise ValueError(f"Context working directory is not a directory: {start}")
    # A manifest is the project boundary. Do not skip an incomplete nested
    # project just because its schema is missing: validation must report the
    # missing contract for that project, not accept an unrelated parent.
    resolved = start.resolve()
    for candidate in (resolved, *resolved.parents):
        if (candidate / ".agents/context.yaml").is_file():
            return candidate
    raise ValueError(
        "No Agent Context project found; run inside a configured repository "
        "or pass --repo-root PATH"
    )


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agent-context",
        description="Portable Agent Context v1 CLI: full README retrieval and source-linked explanations",
    )
    parser.add_argument(
        "--repo-root", metavar="PATH",
        help="project root containing .agents/context.yaml (or AGENT_CONTEXT_REPO_ROOT)",
    )
    parser.add_argument(
        "--version", action="version", version=f"agent-context {CLI_VERSION}"
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--topic", metavar="TOPIC", help="README context topic")
    selection.add_argument("--path", metavar="PATH", help="file/directory owned by a README")
    selection.add_argument(
        "--files-changed", action="store_true",
        help="resolve owners of Git changed and untracked files",
    )
    parser.add_argument(
        "--format", choices=("markdown", "json"), default="markdown",
        help="render complete README text as Markdown or JSON (default: markdown)",
    )
    parser.add_argument(
        "command", nargs="?", choices=("validate", "explain"),
        help="validate metadata only, or explain included sources without README bodies",
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        root = find_repo_root(args.repo_root)
        if args.command == "validate":
            if args.topic is not None or args.path is not None or args.files_changed:
                raise ValueError("validate does not accept document selection options")
            result = validate_context_contract(root)
            print(
                f"Validated Agent Context v{result['manifest']['contextVersion']}: "
                f"{len(result['validatedDocumentIds'])} source-backed README contracts "
                f"under {root}"
            )
            return 0
        bundle = resolve_context(
            root, topic=args.topic, path=args.path, files_changed=args.files_changed,
            explain=(args.command == "explain"),
        )
        sys.stdout.write(render_context(
            bundle, output_format=args.format, explain=(args.command == "explain")
        ))
        return 0
    except (ValueError, OSError, UnicodeError, yaml.YAMLError, SchemaError,
            subprocess.CalledProcessError) as exc:
        print(f"agent-context: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
