# ABR-84 (D5) — Portable, versioned agent context handoffs

**Contract:** A coding-agent handoff includes the instruction and the complete C1–C5 source-linked Agent Context README snapshot in one verifiable envelope. The contract is used by the canonical agent-context skill and the Linear code-review handoff skill. It is documentation/context data, not execution permission.

## Create

From a reviewed Git checkout, prepare the message in a UTF-8 file, and choose the owner by --path or --topic (or --files-changed):

`python3 scripts/agent-context-handoff.py create --repo-root . --repository REVREBEL/linear-agents --message-file /tmp/agent-message.md --topic profiles --format markdown --output /tmp/context-handoff.md`

The result is a Markdown handoff message with the original instruction and one AGENT-CONTEXT-HANDOFF/V1 JSON block containing the entire untruncated README content. Use --format json --output /tmp/context-handoff.json to create a machine-readable attachment.

| Field | Meaning |
| --- | --- |
| handoffVersion (1) | Contract version, separate from Context v1 |
| repository | Portable Git owner/name identity, never a credential-bearing URL |
| repoCommit | Pinned Git commit, independent of the receiver's current HEAD |
| contextBundle | Full existing Context resolver JSON including selected READMEs, dependencies, inclusion reasons, source paths and Git provenance |
| contextSha256 | SHA-256 of canonical JSON for the complete context |
| message, messageSha256 | Exact agent instruction and content hash |
| handoffSha256 | SHA-256 of all preceding envelope fields |

Each selected README carries its id, sourcePath, gitSourcePath, gitSha, gitHeadSha, sha256, worktreeModified=false, requires, reasons and full content. This makes the handoff self-contained even after the originating host's optional /opt directories disappear.

README modifications not committed to Git, missing document bodies and inconsistent provenance are rejected. Selected optional host documentation is required by default; --allow-partial is an explicit opt-in that retains the original C4 partial/missingDocuments evidence. A partial handoff is never represented as complete.

## Verify before continuation

`python3 scripts/agent-context-handoff.py verify --input /tmp/context-handoff.md`

`python3 scripts/agent-context-handoff.py verify --input /tmp/context-handoff.md --repo-root /path/to/checkout --check-source`

The receiver checks version, fields, dependency references, full README bodies and hashes. With --check-source it additionally verifies each README's exact bytes from the pinned Git commit, original last-modifying SHA, and manifest ownership using Git objects. The checkout can be located elsewhere and the original host READMEs need not exist. If the pinned commit is unavailable, verification fails rather than silently switching to the current HEAD.

Hashes are *integrity checks*, not cryptographic signatures or proof of sender identity; source-linked content does not authorize Bridge execution, credentials, model changes or profile permissions.

## Delivery and replay rules

1. Prepare a full versioned handoff message or full JSON artifact **before sending an actionable coding-agent handoff** or a return-to-agent review instruction. The receiving message must include the full envelope or provide a durable receiver-accessible artifact link alongside its repository, pinned Git commit and handoffSha256. A short summary or lone SHA is insufficient.
2. The next session reads the complete artifact and runs verify, preferably with --check-source using a checkout that has the pinned commit. It does not re-resolve the current HEAD and claim the old context was reproduced.
3. If the channel cannot carry or retrieve the full artifact, report the handoff as incomplete/blocked; do not claim the context was delivered. Never embed secrets, OAuth tokens, local private runtime profiles or unrelated session transcripts.
4. Keep contextBundle.partial, missingDocuments, unmatchedPaths, document versions and original source paths visible. Do not discard dependency or provenance evidence.

**Scope:** D5 adds a required skill workflow and portable envelope creator/verifier, with regression tests for independent-session replay and tampering. It does not rewrite old Linear comments, modify the live Bridge webhook transport, automatically post oversized bundles, or install a new binary in /opt. Existing senders have their own prompt limits; use a durable attachment when necessary. A future transport adapter can reuse this canonical envelope without inventing another provenance format.
