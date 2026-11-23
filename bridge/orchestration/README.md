# Bridge orchestration

Canonical modules: `job-admission-coordinator.mjs`, `local-execution-coordinator.mjs`, `remote-execution-coordinator.mjs`, `prompt-arguments.mjs`, `review-inbox.mjs`, `review-delivery.mjs`, `review-message-handoff.mjs`. Ubuntu owns durable state. Coordinators do not create listeners or move state. Job adapters live under `../../jobs/`; transport remains under `../../routing/`.

## ABR-99 — MCP progress and review integration boundary

`mcp-milestone-integration.mjs` is a library binding server-verified Linear job/session/tenant/repository/issue/host/branch to the **existing** ledger, file-locked checkpoint and durable ChatGPT user review inbox. Interactive tools and lower-trust output cannot mint handles or update the task. The adapter adds per-tool replay prevention, bounded redacted milestone/recovery context, optional canonical D5 full handoff verification and a **disabled-until-injected** ABR-17 `submitWork` path. The only approved review queue is `review-inbox.mjs`; enqueue is not delivery/ACK. No new CLI or live HTTP ingress is installed. [ABR-99 source and negative tests](../../docs/audits/mcp/BRIDGE_INTEGRATION.md).

PR #262 review fixes: the D5 adapter snapshots and recursively freezes the same bounded JSON envelope before asynchronous verification and returns only that snapshot. Tool summaries are normalized to the exact bounded form preserved by the canonical checkpoint sanitizer; truncation never splits a redaction marker or causes an identical receipt retry to increment the checkpoint revision.

## ABR-17 M1 — Submission coordinator

`submission-coordinator.mjs` enforces trusted coding-job binding, confirmed issue and sanitized summary, exact pre-pushed Git/CI evidence, one issue owner and one PR across revisions, and durable before-effect intents through the job-state submission outbox. It requires explicitly injected trusted publication/Linear/review/Worker adapters and refuses ambiguous retries until verified reconciliation. Disabled by default and not imported by the runtime. See [contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

PR #264 review: capability lifetime is checked after asynchronous job-ledger reads and again before external invocation; expired or revoked handles cannot begin a new effect or reconcile a pending intent. Admission also rejects expiry during its initial ledger lookup.

## ABR-17 M2 — Trusted launcher ingress and confined preflight

`submission-ingress.mjs` validates immutable launcher scope, current canonical job fields, mapped app/installation, expiration and independent runner evidence. Its private admission proof includes a liveness callback used by the M1 coordinator before external effects. `submissionLedgerFields` is a trusted dispatcher metadata builder, not a job writer. `submission-git-preflight.mjs` requires approved canonical workspace, actual confined Git branch/HEAD/status/origin and operation marker reads, then exact provider-confirmed remote branch, base and required checks. Git worktrees with metadata outside the approved sandbox are denied; Mac/linked-worktree support and final publication revalidation remain gated. See [M2 contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

## ABR-17 M3 — Publication and terminal outcomes

`submission-publication.mjs` binds explicit repo/agent bot policy, rechecks Git and PR before every downstream mutation, reuses the original PR or rejects closed/ambiguous history, and requires a valid reviewer route. The coordinator supplies a fresh authorization callback at the side-effect boundary. The explicit trusted `submitFailure` path journals failed/blocked completion before invoking Worker error activity; it does not publish or move an issue to In Review. Recovery reads the provider and current inbox by exact operation identity without replay. See [M3 contract](../../docs/ABR17_SUBMISSION_COORDINATOR.md).

## ABR-17 M4 — Shared managed provider lifecycle

`managed-submission-service.mjs` composes M1–M3, `managed-provider-launch.mjs` supplies minimal native specifications to an independently approved isolated supervisor, and `managed-submission-runner.mjs` attaches a single one-shot finish operation to the live canonical job. The exact final Git head is captured independently at finish; existing outbox/adapters own all publication. Managed admission bypasses legacy credential synchronization. ABR-99 can bind its existing verified grant to this same operation through createMcpIntegration; no second queue or publishing authority. Native host security, descriptor propagation, actual MCP transport and remote execution need separate acceptance.

Legacy AGY quota retry recovery remains per-record, independent of managed submission enablement. Managed waiting-quota records never resume via the legacy timer; both startup and timer execution use the same predicate.

## ABR-17 M5 — Operator reconciliation

The offline coordinator recovery mode forbids ordinary admission, reconstructs the exact job scope and journal identity from persisted state, verifies current quiescence/exclusive lease and operator approval, and observes one pending effect with M3 readbacks. Terminal journal/ledger mismatch can be repaired after independent terminal observation. Nonterminal progress requires separately authorized continuation; no mutation replay. Production startup additionally requires protected verifyActivation and actual service-UID sandbox success.

## ABR-59 M13 — protected host client

`verified-memory-bridge.mjs` optionally loads the exact root-owned, non-symlink `/etc/agent-bridge/verified-memory-host.mjs` **client** only when enabled in the existing Bridge service. It checks every ancestor and entry for root ownership and no group/other writes. The installed client must connect to an independently protected operator service; it must not contain signing keys or assume the bridge Unix account has root privileges. It exposes only a trusted `repositoryIdForRoot` mapping, bounded `getApprovedScopedRecall` and advisory `notifyIssueCompleted`; foreign, altered, expired, oversized or unsafe references are omitted, and host errors/timeouts are logged as redacted statuses. No new public endpoint, model authority, direct memU CLI retrieval, privilege escalation or automatic activation. See [M13 integration contract](../../docs/ABR59_VERIFIED_MEMORY_LIFECYCLE.md).

## M14 — protected host implementation

The proposed standalone `memory/host-ipc/verified-memory-host.mjs` can be installed as the exact root-owned `/etc/agent-bridge/verified-memory-host.mjs` client. It uses only a fixed AF_UNIX socket and bounded operations; root peer authentication pins the actual Bridge systemd MainPID, not just the agent-shared Unix uid. Its approved canonical repo mapping and per-job allowlist are root-controlled and unavailable to coding agents. No installation or service activation occurs on PR merge. See [M14](../../docs/ABR59_M14_ACTIVATION.md).

M14 review correction: optional signed memory recalls have a 12.5-second Bridge deadline so an independently bounded eight-second native PostgreSQL worker can finish after IPC and file-verification overhead. The protected client caps its read at 11 seconds; repository mapping and completion hints remain limited to 1.5 seconds. A timeout never escalates authority or retries an uncertain write.

For M14 production promotion, `completionHint` returns boolean `true` only
after the root IPC acknowledges a durable intent for the exact pinned
canonical job. This is a queue/retention acknowledgment, not evidence of
approval or a successful native write. The `/issue-completed` handler uses
that return to preserve the original admission task file; denied or
unavailable root calls return `false` so ordinary issue cleanup is unchanged.


The protected completion client distinguishes
`{status:"accepted",jobKey}` (a root-pinned durable intent),
`{status:"denied"}` (explicit root rejection) and
`{status:"uncertain"}` (possible lost acknowledgment or timeout).
Only exact accepted job keys grant scoped retention; uncertain results
conservatively retain authenticated-issue evidence for operator review.
Previous durable ledger retention persists across later responses.
