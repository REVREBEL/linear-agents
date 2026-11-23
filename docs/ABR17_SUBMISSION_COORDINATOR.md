# ABR-17 M1 — Bridge-owned Submission Coordinator

**Reviewable milestone, disabled by default.** The final agent UX remains
`submit-work ABR-17 "Summary of implemented work"`. M1 establishes the
coordinator and durable effect contract, not that installed runner command.

## Authority and ownership

The existing canonical job ledger remains the only job authority. The
coordinator requires independently verified admission, a live job matching
tenant, coding agent, issue UUID/identifier, session, host, repository/root,
branch/base, mapped GitHub App/installation identifiers, submission cycle and
expected SHA. A private handle is minted only from that admitted scope.
Caller inputs contain issue confirmation and bounded redacted summary only.
No caller-selected credentials, SHA, PR number, URL or workflow state.

A SQLite transactional effect journal sits in the existing authoritative
job-state directory, not on both Mac and Ubuntu and not in the code workspace.
Unique issue ownership prevents overlapping publication attempts, while an
issue/head constraint prevents duplicate revisions. The record preserves the
previous PR for a later authorized new head under the same publication
scope; changing repository, branch, base or installation fails closed.

## Source state machine

received → validated → git_ready → github_published → linear_posted →
in_review → review_queued → session_closed

Every step records its pending intent durably before invoking a trusted
adapter. The preflight policy is **already committed, clean, pre-pushed
branch, exact matching remote SHA and verified required checks**. M1 never
stages, commits, pushes or bypasses CI. Real Draft PR management and
preflight readiness policy remain in the publication adapter milestone.

Each external receipt is reduced to approved fields and checked against
the pinned admitted scope. PR numbers are verified with exact repository,
head/base and app/installation; a revision must reuse the previous PR.
The successful workflow state is In Review; a review queue receipt is
not reviewer ACK. Worker completion must say completed (not complete).
The coordinator never marks the issue Done, merges, or clears the inbox.

An ambiguous or invalid response leaves the exact pending intent intact.
Retries return reconciliation_required, not a duplicate external write.
An explicit trusted recovery verifier may affirm the exact operation ID
and observed receipt; revalidate the current job and persist that receipt
before later steps can proceed. If the canonical job is already interrupted
or scope has changed, fail closed pending the reviewed recovery admission
flow. The first milestone does not provide a tenant-controlled retry/reset,
nor a terminal failed/blocked Worker adapter.

## Verified and outstanding

M1 tests are actual file-backed job and SQLite journal tests with exclusively
injected external-effect fixtures. They do not authenticate to GitHub or
Linear, and do not verify a real app installation. Existing provider dispatch
currently exposes credentials through legacy runner contracts; these must
be replaced with a narrowly scoped launcher-owned capability before live
submission. Do not expose GitHub App keys/JWT/install tokens, Linear OAuth
or Bridge shared credentials to agents.

- M2: authenticated local ingress and per-runner scoped capability, authoritative
  ledger enrichment, real read-only Git preflight and GitHub credential broker;
  inspect mapped app installations and permissions through trusted host configuration.
- M3: real GitHub/Linear/Worker adapters with independent verification and
  recovery, Draft/Ready distinction, explicit blocked/failed session handling.
- M4: AGY/Trae/OpenCode finish integrations, minimal provider-neutral skill and
  dedicated AGY workflow; ABR-99 integration must share the same coordinator.
- M5: independently authorized actual staging, security review, deployment and
  rollback proof. ABR-18 owns actual reviewer notification and ACK.

## Rollback

No runtime import, listener, credential use or service activation is introduced.
Keep the feature disabled; retain pending effect records for forensic
reconciliation. Never remove the existing job ledger, blindly repeat a
publication, close a session twice or delete the task inbox.

## M2 — Private runner ingress and verification boundary

M2 builds on the reviewed M1 branch rather than replacing the canonical ledger
or creating a second server. It is disabled by default and requires trusted
launcher and runner verifiers. The launcher produces an explicit, immutable
scope (including the independently confirmed final commit SHA) from admitted
routing and worktree metadata. `submissionLedgerFields` converts that scope to
canonical job metadata for the existing dispatcher; it does not mutate a
ledger or trust issue text. The current runtime must be adapted in M4 to
populate these fields and supply authenticated local/remote runner provenance.

### Private command transport

The launcher hands the command a private duplex FD 3; the command accepts only
the issue identifier and summary, using bounded JSON framing. The trusted
channel handler carries the scoped capability and peer evidence on its own side.
A SHA-256 of an ephemeral per-job random capability is held in memory; expiry,
launcher authorization, runner verification, and exact current ledger scope
are required. The M1 coordinator receives the ingress admission verifier and
liveness predicate together, so revoking the channel also stops new submission
effects. A lost response does not replay a pending M1 intent. No generic public
socket, arbitrary listener, caller-supplied peer identity, or shared-secret
fallback is installed. The actual child process uses no API token in argv or env.
Same-UID peer isolation and secure remote Mac runner transport require the
reviewed production launcher in M4; the Unix socket server in tests is disposable.

### Git and GitHub preflight

The existing ABR-96 sandbox performs real Git inspection of an explicitly
approved canonical root, requiring an exact branch and head, clean tracked and
untracked status, no in-progress merge/rebase/etc., approved GitHub origin,
matching remote head, distinct existing base, and every explicitly configured
required CI check. Required checks are named and bound to an issuing GitHub
App ID; unverified, ambiguous, incomplete or non-successful checks fail closed.
No shell command from the caller, network-enabled Git, commit, push or file
mutation is performed. The test covers an ordinary fixture checkout inside
Linux Bubblewrap. External .git metadata (linked worktrees), macOS sandbox
support, real bridge-UID namespace confinement and final pre-publication
revalidation are still required before operational use.

The host-only broker accepts explicit operator-provided mappings, never guesses
the first installation. It validates app and repository installation with a
short-lived RSA-signed JWT, uses a repository-ID-scoped read-only token with
explicit contents, PRs, checks, statuses and metadata permissions, verifies
the returned repository/permission/expiry scope, caches and refreshes
privately, and exposes only narrow read methods. Current legacy Trae helper
can return an installation token and pick the first installation; it is not
used by this path. Existing source configuration does not establish complete
operator-approved mappings. The actual installed app IDs, repository IDs,
installation permissions/API response compatibility and approved key provider
must be verified by the owner before any live activation. The fixture checks
JWT signatures and token narrowing without loading a real key or reaching GitHub.

M3 will add real scoped publication authority, actual PR/head/base and CI
revalidation at the mutation boundary, Linear and Worker adapters, and
independent recovery. M4 must integrate the existing dispatcher/runner
transport and remove credential exposure in legacy provider contracts.

## M3 — Verified provider publication and recovery

The coordinator remains disabled by default. M3 adds host-only provider
clients and composition, not a deployed dispatcher integration. All tokens
and private keys are obtained through approved host callbacks, never from
agent inputs. The broker defaults to read-only; its explicitly enabled
publication permission adds only pull_requests:write scoped to the configured
repository ID and verified installation, with no contents write. No Git push,
force-update, merge, or deployment is performed.

The repository's configured agent mapping must include the verified GitHub
bot user ID and the ready/draft policy. GitHub PR history for the exact
branch is queried with state=all; closed, mismatched or ambiguous history
is refused rather than replaced. An existing open PR must have the issue
marker, configured bot author, pinned repository/head/base and original
PR number for a revision. A new PR records its initial verified head.
Revisions use the same PR (the existing pre-pushed branch advances it),
with new evidence in Linear and the canonical review inbox. All configured
checks are independently read at publication and again before downstream
mutations. A draft is an intentional external effect; the outbox remains
pending at github_published until an explicitly authorized operator marks
the PR ready and the read-only recovery verifies it. M3 does not
automatically convert drafts or wait for PR-only CI. M1's pre-pushed,
pre-verified-check policy is retained.

Linear uses a fixed GraphQL endpoint, a private token loader, and explicit
tenant/organization, agent app user, exact team and workflow state mapping.
Comment publication includes the PR, exact submitted head, configured
verified-check status, sanitized descriptive summary and deterministic
operation marker. Verify the saved comment and author using a bounded full
connection; a missing, duplicate or conflicting result is not proof.
Transition only to the configured started-type In Review state in the
same team. Independently read back the actual state. A missing or ambiguous
review routing destination prevents publication. The existing durable
ChatGPT user-review inbox receives the canonical ready_for_review event;
queued does not imply reviewer notification or acknowledgment. ABR-18 must
reconcile webhook and coordinator event deduplication across event types.

Worker completion uses the mapped HTTPS /complete endpoint, the actual
existing agentSessionId/organizationId/status/activityType/body contract,
and never forwards the Worker secret to an agent. Before writing, read
the scoped Linear session and require the expected issue and app user.
Completed status requires In Review and the verified review inbox.
Then independently query Linear AgentSession activities, verifying
the exact operation marker, content type, author, archived/ephemeral/signal
state, session status and latest activity. Worker request statuses are
completed/failed, whereas Linear session statuses are complete/error.
A transport acknowledgment is not a verified completed session. Source:
https://linear.app/developers/agent-interaction and
https://linear.app/developers/agent-best-practices (Agent Session lifecycle,
Agent Activity union, activity queries); the existing shared Worker
delivery-coordinator contract owns /complete routing.

An explicit trusted failure or blocked submission is a distinct
received → failed/blocked journal path: terminal error activity only, no
GitHub publication, In Review or reviewer queue. It cannot overwrite a
successful or uncertain submission. Known terminal failure retries are
read-only; pending ambiguous failure effects require independent observation.
Existing runner integration must supply this explicit outcome, not infer it
from an agent's prose or provider timeout. Recovery requires trusted
operator/host approval and only performs reads of the pending operation.
No automatic replay, no second task authority.

### Actual evidence and remaining gates

M3 tests run real source clients using fixed provider URLs and injected
fixture transport, test-only RSA keys, actual canonical ledger, SQLite
outbox and review inbox. The direct Linear read-back contract is tested
with provider-shaped fixture responses; credentials, installed app
permissions, GraphQL schema/actor compatibility and production behavior
are not verified by these fixtures. M2 covers actual confined Git reads.
Missing/changed live evidence remains pending or denied, not fabricated
success. M4 must wire the authenticated dispatcher and provider finish paths,
including explicit failure handling, canonical ledger fields, trusted
credential source, ABR-99 coordinator binding, and the minimized common
skill. M5 must independently verify actual permissions, Linux/Mac policy,
approved staging issue and real provider lifecycle before enabling.

## M4 — Managed native finish integration

The existing authenticated /jobs route now selects the shared managed
submission service for Antigravity, Trae and chatgpt-cli when explicitly
enabled. Default off preserves the legacy dispatch path. Managed admission
does not exchange or persist legacy workspace Linear credentials, and does
not fall back to the legacy callbacks or Mac SSH dispatch on failure.
The existing process ledger must durably record accepted managed launch
before duplicate delivery is acknowledged. The runner prevents overlapping
managed work in one repository within the authoritative process. A native
process exit or final response is not submission evidence. Explicit success,
failed or blocked requests enter M1–M3; pending effects or missing
requests remain awaiting_external. The final committed SHA is independently
captured from the pinned branch via the existing read-only Git sandbox.
An explicit failure still requires a bindable approved branch/head.

The managed provider specifications use the actual native CLI invocation
shape: AGY Python --managed reads the trusted startup prompt from stdin
and passes FD 3 to agy without Worker activity calls; Trae receives the
chat command; chatgpt-cli receives OpenCode run --format json with the
approved model. The specs use a strict environment allowlist and include
the trusted command/issue-confirmation finish instruction independently
of any skill loader. The host supervisor must preserve the private duplex
FD through the native tool subprocess, protect host credentials/files
from the entire child tree, police egress and terminate the tree at expiry.
It cannot be replaced by direct spawn in production. Provider/CLI
credential stores, any legacy .env.linear-bridge files, git credential
helpers, SSH keys and the Bridge filesystem must not be readable by the
managed agent except for separately approved model access. No claim that
the current same-UID native executables meet these requirements is made.
The shared submission skills distinguish managed and legacy turns.

### Protected host binding and activation (operator-only; M5)

Setting BRIDGE_MANAGED_SUBMISSION_ENABLED=true requires Linux and a
root-owned regular /etc/agent-bridge/managed-submission-host.mjs with
root-owned non-writable ancestors, exporting createHostBinding().
The flag is not set by this PR. The private implementation is **not
installed or supplied by repository source**, and startup fails if absent.
The trusted host binding owns:

- githubMappings, linearMappings, workspaces, publicationPolicies per
  M2/M3, and providerConfigs for all three native providers. Each
  provider config includes absolute binary, commandPath, minimal env
  (HOME/PATH and permitted locale/XDG/temp values); AGY requires python,
  OpenCode requires model. The command path is installed and pinned by
  the operator, not resolved from issue text.
- resolvePlan(request): independently authorize coding role and exact
  agent, jobKey, sessionId, tenantId, issueUuid, repository/root, workspace,
  projectId, mapped appId/installationId, explicit branch/base, commandPath
  and expiry (at most one hour). Refuse clarifications and noncoding turns
  unless separately supported; do not infer a branch or role from prose.
- isolatedSpawn(spec, context): synchronous supervised ChildProcess-shaped
  result with actual spawn/close/error events and inherited private FD 3.
  Supply approved isolation, peer identity, process-tree cleanup and
  descriptor propagation. Never inject host environment or auth material.
- loadPrivateKey, loadLinearToken, loadWorkerSecret and verifyRecoveryRequest:
  trusted host-owned credential retrieval and operator authorization. No
  secrets may be passed to model processes, prompts, logs or job artifacts.

The source service constructs one M1 coordinator, ingress, canonical
outbox and provider adapter set. Its createMcpIntegration factory binds
ABR-99's authenticated Linear coding grant to the same one-shot live finish
operation, checking scope and grant liveness. It does not run the previous
independent PR-verifier/inbox-enqueue path when managed mode is selected.
Actual authenticated MCP transport registration is separately gated; the
existing MCP route is not exposed by this PR. No second PR or reviewer
queue is created by the managed MCP adapter.

### M4 evidence and M5 release gate

M4 fixture tests run actual submit-work child processes / private IPC,
the provider-specific startup specs (with mocked native executables),
canonical ledger, real SQLite outbox, M3 signed fixture APIs and review
inbox. The M2 suite exercises actual confined Git. Native AGY/Trae/OpenCode
tool descriptor inheritance, isolated supervisor, per-process identity,
legacy credential cleanup, linked worktrees, Linux service UID sandbox,
Mac transport, actual GitHub/Linear app permissions and live API/session
verification remain unestablished. M5 must resolve these before any
production activation; it also needs a protected operator recovery entrypoint
and explicit recovery of interrupted/uncertain managed jobs, approved
staging, production credential verification, review of live CI policies
and rollout/rollback. No automatic restart/replay or quota retry in
managed mode. Retain the journal pending reconciliation. Rollback disables
the flag only after stopping/reconciling managed in-flight work; restore
the previously approved legacy configuration. Never reinterpret an
ambiguous external effect as permission to launch a legacy job.

## M5 — Operational evidence, operator recovery and rollback

**Release remains blocked.** Source and isolated-fixture success is not
permission to activate the production service or launch additional agents.

### Verified source and Linux fixture results

The managed runtime now requires a clean exact release commit, a successful
strict sandbox probe under the non-root service UID, and an explicit
root-owned host binding verifyActivation({head,uid,hostId,repositoryRoot})
decision before startup. CLI/root fixtures cannot grant that decision.
The fixed binding also owns the actual native isolation implementation;
the operator must separately prove native runner descendant FD propagation
and credential/egress separation. An exclusive SQLite lease under the
canonical job-state directory prevents a second managed authority or
offline recovery process from co-owning this ledger. It releases on crash.

The M5 sandbox fixture exercises the actual submit-work command through
Bubblewrap with FD 3, and verifies a host-only sentinel and host loopback
listener are inaccessible. This was executed as root only inside a disposable
fixture namespace, not as the live bridge service UID or actual native CLI.
M1–M4 retain the mapped fixture provider, real durable outbox/inbox,
controlled lost-response, revision and duplicate tests.

### Host observation (November 20, 2026 PT)

Read-only probe against rebel-server:
- Existing agent-bridge service active, user bridge UID 994.
- Protected /etc/agent-bridge/managed-submission-host.mjs: absent.
- Actual service-UID Bubblewrap probe: namespace creation permission denied.
  kernel.apparmor_restrict_unprivileged_userns=1; kernel.unprivileged_userns_clone=1.
  Do not globally disable AppArmor or elevate the service to root.
- AGY and OpenCode discoverable on the checked service PATH; Trae not
  discovered there. An explicitly configured absolute Trae launcher remains
  to be verified per the host policy.
- Offline operator command denied while the service was active.
- Actual installed provider mapping, live OAuth/session reads, PR identity,
  model egress, native descendant IPC, Mac transport and deployment
  approval remain unestablished.

Repeat the read-only probe from the reviewed checkout:

```sh
python3 scripts/submission-host-readiness.py
```

Exit 2 is deliberate: discovery and host inventory alone cannot grant
release approval. The report contains no credential values, raw logs,
environment dump, provider mutation or agent start. The sandbox check
runs as the configured non-root service account where possible.

### Operator-only interrupted-effect recovery

The new offline recovery composition uses the same canonical job store,
outbox and M3 readback checks, with a separate read-only GitHub token
permission set. It cannot mint active runner handles or call a publication
adapter. It derives the submission ID and full scope digest from the
managed persisted job, not from CLI-supplied PR, SHA, credentials or
provider receipt. Only an explicitly approved exact operation may be
observed. If the observed receipt is valid, repair its pending intent
and the local job ledger. If the journal was already terminal but the
job ledger was not, independently re-observe the terminal receipt
before repairing it. An ambiguous observation stays pending. Recovery
does not perform the next external effect; a nonterminal recovered row
requires separately authorized continuation. No attempt is made to
invent a receipt or repeat a mutation. Known stale PID must be resolved
by the trusted host's quiescence verifier, not assumed dead from a number.

For a **separately approved** offline maintenance window:
1. Stop new admissions and drain or stop the entire managed process tree.
   Record the exact pending operation, job, release SHA and owner approval.
   Keep the canonical ledger/outbox/inbox intact with a protected backup.
2. Verify agent-bridge.service is inactive, MainPID=0, no separately launched
   Bridge or runner is active, and the protected host binding asserts per-job
   quiescence. Use the service UID and reviewed installed checkout, never
   an agent environment or untrusted worktree.
3. The operator runs `node scripts/recover-managed-submission.mjs JOB_KEY APPROVAL_ID`
   from the installed release. Arguments are exact job key and approval
   identifier only. Binding must provide jobsDir equal to the installed
   runtime ledger, projectsRoot, routingConfigPath, verifyOperatorRecovery
   (approve exact recovery request), verifyRecoveryRequest (approve exact
   observation), and synchronous assertQuiescent(job). Existing credential
   callbacks are read-only for this operation; Worker secret access and
   PR creation are unavailable.
4. Record the verified stage and receipt. Terminal repair is complete only
   when independent provider evidence matches; if continuationRequired=true,
   return the issue to the explicitly authorized continuation workflow.
   Do not clear pending records, reset the journal, launch legacy agents,
   or retry GitHub/Linear/Worker writes to guess whether they succeeded.

### Deployment acceptance checklist (no approval inferred)

| Gate | Required evidence | Status |
|---|---|---|
| Reviewed release | All stacked M1–M5 PRs independently reviewed, exact approved release SHA and actual CI | Pending |
| Linux host | Narrow reviewed service-specific namespace profile; strict actual UID probe; native process/FD and egress tests | Blocked |
| Private host binding | Approved root-owned configuration, installed pinned command, operator approvals, real credential provider, isolated supervisor | Missing |
| Credential isolation | Explicit mapped app/repository/install IDs and verified permission/identity reads; no readable legacy tokens, keys, unsafe helpers or excess agent network access | Unverified |
| Native canary | One approved disposable staging assignment per AGY/Trae/OpenCode, actual inherited finish operation, no secrets in child, correct failure path | Unverified |
| Real handoff | Exact clean Git branch/head/required checks, mapped PR identity, one PR/comment/In Review, exact session terminal activity, replay and revision evidence | Unverified |
| Recovery | Operator-approved staging interruption and receipt readback without repeated external effects | Fixture only |
| MCP / Mac | Actual authenticated ABR-99 transport and separately approved remote host, linked-worktree and isolation policy | Unverified |
| ABR-18 | Review delivery/acknowledgment and cross-event deduplication; queue is not ACK | Separate dependency |

### Approved rollout and rollback sequence

After independent review and owner approval, provision only the narrowly
scoped host policy, isolated model transport, protected mappings, command
and recovery approval binding; verify actual service-UID sandbox and native
launcher before enabling the flag. Exercise a disposable staging job with
approved provider identities and actual required checks; verify every receipt
and confirm the task inbox is retained. Record sanitized outputs and exact
release SHA. Do not enable Mac production rollout until separately approved.
If any gate fails, remain disabled and reconcile the exact effect.

Rollback: stop new managed admissions, quiesce the managed process tree,
retain existing ledger/outbox/inbox and observe pending effects. Disable
BRIDGE_MANAGED_SUBMISSION_ENABLED only after reconciliation/planned handling
of in-flight jobs, restore the last approved service configuration and
validate existing authenticated health and legacy quota recovery. Keep
unresolved managed job records distinct from legacy retries. Revoke only
new test grants and remove only approved dedicated test artifacts; never
merge, mark Done or delete the existing task inbox as rollback.

### November 20, 2026 PT — approved host-policy correction and live preflight

The operator authorized the server-security modification followed by live
staging checks. On the Ubuntu 26.04.1 host, the kernel audit log identified
unprivileged user namespace creation denial; the installed general AppArmor
loader was disabled and only the Docker policy was loaded. The existing Ubuntu
packaged bwrap-userns-restrict policy was syntax-checked and loaded unchanged.
Both bwrap and unpriv_bwrap are enforcing; its child profile strips namespace
capabilities. The dedicated root-owned enabled systemd unit loads only that
packaged profile before Bridge at boot. See scripts/linux/systemd/
agent-bridge-bwrap-policy.service.example and scripts/linux/README.md.
The global apparmor_restrict_unprivileged_userns setting remains 1.
The existing service stayed active with its original PID.

The strict sandbox probe passed as actual UID 994 (bridge). All 57 tests
across the strict executor, AST/Git confinement, M2 and M5 suites passed
under that actual account, with zero skips, including the real private CLI
FD 3, host filesystem/network denial, exclusive lease and interrupted-effect
fixtures. A first run hit the host's existing non-writable /tmp; rerun used
a private service-owned /var/tmp fixture directory without changing system
permissions. The host readiness probe now uses the actual installed Node
binary rather than the Volta shim with an inherited HOME.

Live staging authentication/preflight at the then-current PR #270 head
84c3f92684228dca8d72e22a1a2d9b85c3803b97 (base feat/abr-17-m4):

| Check | Observed evidence |
|---|---|
| Configured Linear identity | HTTP 200; real organization identity |
| Antigravity Linear Worker token exchange | HTTP 200 GraphQL, expected separate Antigravity actor and matching organization |
| Trae Linear Worker token exchange | HTTP 200 GraphQL, expected separate Trae actor and matching organization |
| ChatGPT CLI Linear Worker token exchange | HTTP 404; health endpoint responds 200; separate CLI credential not established |
| GitHub organization installation inventory | Antigravity, Trae and ChatGPT apps installed, unsuspended; required contents/checks/statuses/PR/metadata permissions present. App membership alone does not prove a scoped installation token. |
| Antigravity actual M3 broker | Live app identity/repository installation (200), narrowed installation token (201), exact repository/branch/PR reads (200); both read-only and restricted PR-write token modes pass. No publication invoked. |
| Trae GitHub broker | Existing configured/default key source missing. |
| ChatGPT CLI GitHub broker | Distinct approved coding key mapping not established. |
| Native execution | AGY and OpenCode discovery passes; configured Linux Trae executable absent. Native descendant/isolated model egress not yet verified. |
| Protected managed host binding | Absent; existing production checkout not the reviewed stacked release. |
| Live PR/Linear/session mutation | Not attempted: protected native launcher/binding and complete mapped credentials are required first; at tested head two CI jobs failed and independent review remained blocking. |

The Antigravity key resolves within its existing shared agent home; it must be
migrated to the trusted host credential boundary and inaccessible to managed
children before activation. Existing legacy credentials were not removed.
Token probes kept credentials in memory, used the actual provider endpoints,
did not persist workspace token files and returned only verification status.
Neither a reviewer credential nor another runner's credential substituted
for the ChatGPT CLI coding identity. Source report remains releaseReady=false;
sandbox gate is now passed, replacing the historical blocked observation
above. Actual native launch, protected operator binding, CI/review,
staging submission and session close, revision/recovery, and Mac/MCP
acceptance remain open. No production managed flag or legacy callbacks changed.

CI review corrections: the real M5 CLI fixture now copies the command into
a private fixture directory and mounts the pinned read-only descriptor,
rather than depending on runner checkout ancestor permissions. The existing
REPL test uses a bounded 2-second readiness deadline within its 3-second
session, still requiring the exact waiting_input state.

Additional live readback check: Antigravity OAuth returned HTTP 200 without
GraphQL errors for the exact M3 issue-read schema on ABR-17, and the M3
AgentSession/activity schema on an existing scoped session from the current
job ledger. Session ID, issue ID and app user matched; the first 100 activity
records were accessible. This validates the query shape and authorization,
not a new terminal activity or a complete staging publication transaction.

### November 23, 2026 — sealed-release Git access and host acceptance

The current sealed production source is a clean, root-owned
`/var/lib/bridge-runtime` checkout at `b9a6035a3c21edbdb5582a19ae12f0544cbc1501`.
The actual `agent-bridge.service` is running as UID 994 and its sealed
startup preflight passes. The narrowly scoped AppArmor/Bubblewrap policy is
active. Under the real `bridge` UID, 47 isolated M2/M5/REPL regression
tests passed with no failures, skipped tests or credential disclosures.

The service-account release verifier exposed an operational blocker:
Git rejected the root-owned release as a dubious ownership checkout, and
the sealed `.git/index` was `0600 root:root`. The fix is a **per-command**
`-c safe.directory=<exact sealed release>` exception, plus a **read-only**
`u:bridge:r--` ACL on that one Git index. A root-operated, fail-closed
`scripts/linux/m5-sealed-git-access.sh` records how to reapply the ACL
after an approved sealed Git deployment. The live service UID successfully
validated the exact clean root-owned release and sandbox after the ACL change;
a dirty checkout was rejected before the (test-only) approval callback.

The read-only host report now derives the Git release and strict sandbox
probe from the service's **actual running Node entrypoint**, not whichever
development checkout invokes the diagnostic. Native binary discovery uses
the service's real inherited PATH, not historic home paths. New parser tests
cover exact Node entrypoint, missing Git metadata, invalid PIDs, and duplicate
or incorrect PATH entries.

**Release gate remains blocked.** The operator binding
`/etc/agent-bridge/managed-submission-host.mjs` has not been installed;
managed submission has not been activated. AGY is not on the live service's
inherited PATH, although its approved absolute binary exists; Trae's native
CLI is installed but its provider config is absent. Dedicated coding-agent
credential isolation, native model egress, successful end-to-end provider
canaries, one-shot publication and recovery proof, MCP/Mac transport, and
ABR-18 delivery acknowledgment remain unverified. None of these findings
is an approval to restart the service, publish a PR, or mark ABR-17 complete.

### November 23, 2026 — ABR-103 native staging isolation evidence

The provider-startup acceptance script
`scripts/abr103-native-staging-canary.mjs` ran under service UID 994
with a service-owned disposable workspace. Each exact native binary
executed successfully within a network-denied Bubblewrap namespace:
Antigravity 1.5.14, OpenCode 1.19.5 and Trae CLI 0.1.0.
A *separate* Python descendant executed inside the same isolation
profile and sent the expected marker on inherited private FD 3;
the tested host-credential paths and host loopback were inaccessible.
The script did not enable managed submission, open a Linear session,
publish a GitHub PR or grant a model credential. Version-startup and
independent FD3 checks **do not** prove FD3 travels through an actual
native CLI model/tool descendant, production-grade process supervision,
authenticated model egress or controlled recovery. The production host
binding is still absent, so ABR-103 remains open.

### November 23, 2026 — staging process-tree termination

ABR-103 follow-up adds a bounded staging process-tree guard. Under the
actual `bridge` UID, seven staging/denial tests passed, including
explicit cancellation and a **500 ms expiration of a detached parent
with a real child process**, verifying the child stopped executing.
The three approved provider native executables continued to pass
network-disabled Bubblewrap startup checks, with independent private
FD3 descendant confirmation and host-secret denial.

This does not close the production supervisor gate: the final launcher
must still prove credentials, authenticated model networking and FD3
through each actual provider tool descendant; it needs operator-approved
configuration, canonical job lifecycle, and real Linear/GitHub receipts.
The root-owned operator host binding is intentionally fail-closed.
