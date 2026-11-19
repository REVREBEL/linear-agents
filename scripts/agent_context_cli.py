#!/usr/bin/env python3
"""Portable Agent Context CLI bootstrap (C2).

C2 exposes metadata validation and a stable CLI entrypoint. Document selection,
dependency retrieval, rendering formats and handoff bundles are implemented in
C3–C5; this executable must not infer execution permission from README text.
"""
import argparse
import os
from pathlib import Path
import sys

import yaml
from jsonschema.exceptions import SchemaError

from context_contract import validate_context_contract

CLI_VERSION = "0.1.0"


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
    for candidate in (start.resolve(), *start.resolve().parents):
        if ((candidate / ".agents/context.yaml").is_file()
                and (candidate / "templates/context/context-manifest.schema.json").is_file()):
            return candidate
    raise ValueError(
        "No Agent Context project found; run inside a configured repository "
        "or pass --repo-root PATH"
    )


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agent-context",
        description="Portable Agent Context v1 CLI (C2 bootstrap; document retrieval arrives in C3)",
    )
    parser.add_argument(
        "--repo-root", metavar="PATH",
        help="project root containing .agents/context.yaml (or AGENT_CONTEXT_REPO_ROOT)",
    )
    parser.add_argument(
        "--version", action="version", version=f"agent-context {CLI_VERSION}"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "validate",
        help="validate manifest, frontmatter, cross-root aliases and dependency metadata",
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        root = find_repo_root(args.repo_root)
        if args.command == "validate":
            result = validate_context_contract(root)
            print(
                f"Validated Agent Context v{result['manifest']['contextVersion']}: "
                f"{len(result['validatedDocumentIds'])} source-backed README contracts "
                f"under {root}"
            )
            return 0
        parser.error(f"Unsupported command: {args.command}")
    except (ValueError, OSError, yaml.YAMLError, SchemaError) as exc:
        print(f"agent-context: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
