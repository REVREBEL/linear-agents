#!/usr/bin/env python3
"""Validate reviewed Agent Context v1 metadata without resolving or running agents."""
from pathlib import Path
import sys

from context_contract import validate_context_contract


if __name__ == "__main__":
    try:
        result = validate_context_contract(Path(__file__).resolve().parents[1])
        print("Validated Agent Context v1 manifest, roots, aliases, frontmatter and "
              f"{len(result['validatedDocumentIds'])} source-backed README dependencies")
    except (ValueError, OSError) as error:
        print(f"Agent Context v1 validation failed: {error}", file=sys.stderr)
        sys.exit(2)
