# Agent registry

This repository's `agents/` directory contains **source-controlled agent definitions and project registry files** used by Agent Bridge. It is **not** an empty placeholder and is **not** a mirror of the server's live `/opt/agents/` directory.

## Ubuntu runtime boundary

- `/opt/agents/` is the canonical host location for runtime CLI profiles.
- Authentication, session databases, conversation history, installed binaries, memory, and runtime caches stay on Ubuntu, outside Git.
- Linux home-directory symlinks to live profiles, if required, are managed on the host.
- Agent definitions here may be versioned and reviewed independently of that private runtime state.

Do not copy a live `/opt/agents/` tree into this repository.
