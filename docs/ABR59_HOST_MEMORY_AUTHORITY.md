# ABR-59 M11 — Host authority and credential isolation

## Security boundary

The operator-only authority is deliberately unwired from the Bridge service. Its caller must be trusted host-side job admission, not an agent-supplied job object, webhook description, prompt, shell command, or model response. M13 supplies that lifecycle integration. The authority pins one authenticated job ID, tenant (Linear workspace UUID), agent, repository, issue, PR, full head SHA, required check names, CI app allowlist and reviewer allowlist. The root and policy are fixed for all retries; the binding is an exclusive, synced record. Credentials and records must live outside the agent-owned checkout. Do not execute the authority from an agent-writable checkout in production.

Promotion requires the existing authenticated same-SHA review, reviewer permission and successful check verification, complete Linear evidence, independently attested Git source, exact journal receipt, and matching exclusive started/confirmed markers. Marker digests bind the native payload including path and revision. Signed approvals contain the receipt and confirmed payload digest; readback checks both markers again. Legacy v1 approval records and pre-M11 journal policies are not silently upgraded. Reconcile under operator supervision rather than retrying uncertain writes. Changed/stale proofs are denied; new approval requires live revalidation. Signed sources expire within 30 days.

## Operator custody

On Linux, reserve `/var/lib/bridge-memory-authority` (root:root 0700). The signing key and active manifest are mode 0600; journal, approvals and job mappings use private subdirectories. Use the reviewed script as root:

- `python3 memory/scripts/manage-host-authority-key.py init` — one-time key generation; never displays key bytes.
- `python3 memory/scripts/manage-host-authority-key.py rotate` — atomic activation of fresh key (90-day lifetime); old approval namespaces become ineligible. Reapprove only after fresh evidence and exact confirmed receipt; never rerun an already committed native write.
- `python3 memory/scripts/manage-host-authority-key.py revoke` — disable signing and recall immediately for subsequent authority calls. Treat any already delivered in-memory references as non-revocable.

Keep this path out of all agent mounts, service environments and repository trees. Do not grant the bridge or agent accounts root access to it. Do not run a root agent with this authority; root can access root-owned files. Keep the reviewed operator-side executable under a root-controlled deployment path. Do not expose raw signing or token-provider functions to agents.

## Evidence configuration

Provision these files mode 0600, root-owned, in the operator authority directory (no secrets in Git):
- `evidence.json`: repositoryId, repositoryNumericId, githubAppId, installationId, linearWorkspaceId, linearActorId, linearTeamId (actual IDs pinned by operator).
- `github-app.pem`: dedicated operator-custodied GitHub App private key.
- `linear-oauth.token`: dedicated read-scope Linear OAuth access token. Rotate atomically in the operator directory when it expires; no fallback to a personal key.
- `canary.json`: job with jobId, scope {tenantId, agentId, repositoryId, issueId}, prNumber and full headSha; policy with requiredChecks, allowedCheckApps and permittedReviewers. Use a real completed issue with a linked merged PR and a distinct authorized reviewer who explicitly APPROVED the final head. Set required check names from actual repository policy, not an arbitrary subset.

The provider verifies the pinned GitHub App installation, mints a short-lived token restricted to the exact repository ID and read-only metadata/pull_requests/checks/contents permissions, and enumerates the resulting single-repository grant. It validates the Linear OAuth actor and workspace, then M9 verifies the actual team, completed issue and linked PR. It never uses inherited environment tokens, agent-owned credential files or arbitrary URLs. GitHub token minting does not mutate a repository. Errors are redacted.

Run the read-only non-writing check as root from a trusted checkout:
`node memory/scripts/verify-host-evidence.mjs`.
A denied stage is a failure, not an activation signal. Do not weaken policy to obtain a green canary.

## 2026-11-20 host verification

Root-only signing custody was initialized; the bridge and rebel accounts were denied access. The running Bridge service has Linear API-key configuration, but an isolated OAuth token was not present in the inspected credential paths. Its configured Antigravity GitHub App key path was unresolved; another discovered agent-side PEM had group-write permission, unsuitable as isolated operator custody. Do not copy or reuse that agent credential for production authority. Live credential provisioning and a successful read-only positive canary remain required. Independent GitHub/Linear connector inspection of ABR-57 PRs #167, #168, #170 confirmed linked merged PRs, but none had an explicit APPROVED review. These are negative candidates, not a substitute for the live host canary.

No production memory activation, service restart or database migration is part of M11.
