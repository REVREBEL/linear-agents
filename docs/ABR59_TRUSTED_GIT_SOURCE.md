# ABR-59 M7 — Trusted local Git-object source attestation

This milestone provides a real, host-side `verifySource` / `verifyCandidate` implementation for the M6 source-approval store and M4 one-shot commit executor. The module is **not wired to the running Bridge service**, does not auto-promote memory, and does not supply GitHub review, Linear completion, signing keys or production database privileges.

## Input trust and source format

`createTrustedGitSourceVerifier({repositories})` accepts an **operator-owned mapping** of canonical GitHub repository identity to an absolute local checkout root. The caller's requested repository must appear in that mapping; the local checkout must resolve to that exact root, and the Git `origin` must resolve to the same canonical GitHub repository identity. Only full 40-hex commit object IDs are accepted. The verifier executes the trusted absolute `/usr/bin/git` binary directly, without shell, through a narrow environment and bounded subprocess timeout/output. It checks the commit object type, the exact tree entry, its `100644 blob` mode (rejecting symlinks, submodules, directories and executables), and compares **the full blob byte-for-byte** with the candidate content. Working-tree edits have no effect.

Each approved learning must be a small, standalone, committed `.md` or `.txt` note under `docs/verified-learnings/`, no more than 600 UTF-8 bytes. `revision: 1` means the complete tracked file at the supplied commit, **not** a guessed summary, substring, extracted multi-paragraph note, or model-selected line range. M4 supplies `headSha`, M6 supplies `sourceGitSha`; if both are supplied, they must match. The independent M3 GitHub authorization receipt establishes whether that commit was truly reviewed and approved. This module attests to the content within the commit; it does not independently establish reviewer authority.

All request scalar values are snapshotted before the first async Git call. Caller mutations, altered SHA/content/path, incorrect checkout origin, unexpected repositories, unsafe paths, Git symlinks and oversized source data result in `false` without emitting source content or hidden Git errors to logs.

## Integration and verification

Pass the returned verifier function to M6's `createApprovedSourceStore({verifySource})` or M4's `executeVerifiedMemuCommit({verifyCandidate})` **from a trusted host-owned orchestration path**. Do not initialize the repositories mapping from agent-generated prompts, issue bodies, MCP responses, untrusted worker metadata or repository source files. Tests seed real disposable Git repositories and commits; they cover clean/mutated working trees, wrong SHA, changed content/path/revision, wrong remote, symlink tree entries, malicious paths and caller mutation during async verification. An integration test passes a real Git attestation through the M6 signed approval record store, while denying invented content.

Run `node --test memory/trusted-git-source.test.mjs`; both bridge and reliability suites include this coverage.

## Remaining ABR-59 release gates

Production authentication still needs independently secured host GitHub/Linear clients, current authority/revocation handling, an approved signing-key custody and rotation process, a restricted DB role/RLS strategy, live **multi-scope** read/write isolation canaries, and a deliberate prompt-side feature switch. This PR does not create an approved learning file, install credentials, change a DB/service, or enable background promotion. Source attestation alone does not authorize promotion.
