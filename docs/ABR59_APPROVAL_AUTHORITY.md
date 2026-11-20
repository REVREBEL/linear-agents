# ABR-59 M6 — Durable source-approval records

The isolated, **unwired** `memory/approved-source-store.mjs` module creates and loads signed, immutable, exact-scope source approvals for M5's read-only memory retrieval boundary.

## Security and provenance

A caller must supply a **separately held operator HMAC key** (32+ bytes), an authenticated M3 journal reader and a trusted repository source verifier. The key must never be saved to this repository, passed in an agent prompt, stored in memU, or obtained from a model/MCP tool response. The module intentionally has **no CLI, network server, new service account, configured production path or production feature switch**.

Before sealing any approval, it validates four matching tenant/agent/repository/issue scope fields; a valid existing journal record for the same PR head SHA, merge commit and receipt ID; source Git commit/path/revision/expiry; an independent source verifier's exact-content verdict; and the M2 lower-trust sanitizer. The signer cannot create a valid approval merely from an agent-provided receipt or a self-reported GitHub approval.

Approvals include the exact source text, digest, source SHA, path, revision, expiry, scope and deterministic receipt ID. The file is HMAC-SHA256 signed with the operator key and placed under a previously provisioned, private, owned 0700 approval root. Files are mode 0600, staged to an fsynced private file, atomically hard-linked under the immutable receipt key and directory-synced. Duplicate replay preserves the original record; conflicting content is refused.

Restart loading takes **explicit receipt IDs**, never searches all memU records, and verifies file type, owner, mode, bounded size, HMAC signature with constant-time comparison, exact requested scope and nonexpired content digest. It provides the `approvedSources` Map and `trustedDigests` Set used by `readScopedMemuFiles`; unsigned, tampered, foreign or expired records cannot authorize recalled database text. Records are lower-trust **data**, not executable instructions.

## Verification and limitations

`node --test memory/approved-source-store.test.mjs` covers restart persistence, content tampering, HMAC key mismatch, unauthorized scope, an unjournaled fake receipt, injection content, immutable duplicates, foreign expiry, filesystem symlinks/modes and a mocked M5 authorized read handoff.

M6 does not provision a key, sign real approvals, configure an authenticated GitHub or Linear host adapter, activate a production read/write path, or expose memory to agents. Future work must provide independently authenticated source/journal/issue clients, an approved operator key custody process, tenant-focused PostgreSQL privilege/RLS controls, live isolated scope canaries, revocation/rotation strategy, and controlled prompt opt-in. No live PostgreSQL data or systemd unit is modified by this PR.
