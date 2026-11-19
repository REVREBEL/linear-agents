# Research metadata is not execution authority (ABR-78 / D2)

The Agent Bridge **research catalog** (`agents/agent-registry.yaml`, `agents/profiles/candidates/`), profile schemas, Git-reviewed README context, staged host runtime catalog and research-promotion proposals describe candidate capabilities and evidence. They are **not** executable registrations, signed binaries, model allowlists, verified host boundaries, job credentials, or authorization.

## Authority boundaries in the current implementation

| Boundary | Source checked by D2 | What it establishes |
| --- | --- | --- |
| Worker identity | `scripts/agent-worker-registry.mjs` reads **only** `agents/registry.json` (Bridge Registry v2); `scripts/validate-agent-registry.mjs` validates its schema, identities, Worker dirs and Wrangler templates | A research candidate cannot become a discoverable Worker by being present in a YAML catalog. A declarative Registry v2 entry is **not itself launch authorization** |
| Job admission | `bridge/server/agent-bridge-runtime.mjs` rejects unauthorized bearer requests before `coordinateJobAdmission()`; `jobs/admission/job-preflight.mjs` resolves project routing and credential readiness before job-store claim | Research README or profile fields cannot stand in for a trusted, authenticated Linear delivery or an admitted, scoped job |
| Promotion | `scripts/review-research-promotion.py` translates only a canonical, source-hashed candidate plus independently submitted mapping/evidence to `status: reviewed-proposal-not-installed` | No implicit executable argv, Worker identity, permission, model change, new host or deployment privilege. It does not write Registry v2, start an agent or deploy |
| Model selection | Reviewed `registry.json` declares a pinned model; the promotion adapter requires matching provider/model evidence | A claimed model ID or `modelAllowlist` in research is **not** proof that an installed provider or runtime model is allowed or available. Runtime/model allowlists, wherever configured, must be checked separately at launch |
| Code integrity/signatures | Research `codeSigned`, `signedExecutable`, provenance URLs and content digests are treated only as untrusted descriptive claims | Hash checks here verify **reviewed source equivalence**, not a cryptographic code signature or trusted publisher. D2 does **not** establish that an independent runtime code-signature check exists or has passed |
| Host isolation | Actual routing/workspace controls and OS/native runtime configuration are authoritative; promotion currently supports only reviewed `ubuntu_agent_server` → `bridge_service` mapping | Candidate `executionHost`, `hostIsolation` or workspace text cannot change executable placement, host permissions or isolation |

Only a separate reviewed Registry v2 change, validated Worker/runner configuration, authenticated admission and active host/runtime controls may lead to an executable operation. Candidate metadata and context retrieval provide **no substitute** for those checks. The promotion adapter checks the **shape** of approval references, but it does not independently authenticate GitHub approvals or live provider/Worker status.

## Continuous source boundary enforcement

`scripts/check-research-authority.mjs` audits **tracked executable files** under `bridge/`, `jobs/`, `routing/`, `linear-agent-bridge/`, `agents/coding/`, `agents/bridge/`, `integrations/` and the Linear Workers, plus the two executable Registry v2 reader/validator scripts. It refuses direct source references to the research catalog, candidate profiles, research proposal compiler/payload, staged host registry or README context manifest/templates.

`scripts/test_research_execution_boundary.py` proves that a fabricated candidate with elevated deployment/git permissions, signature claims, model claims and host-attestation text **cannot** appear in `getWorkerRegistry()` or `requireWorker()`. It tests fake import rejection, the bearer-before-admission ordering, source-scope distinction, and proposal non-installation. Existing promotion tests separately reject privileged permissions, different execution hosts, unreviewed models, unsafe argv, Worker drift and unauthorized credentials. They also verify that extra research signing, model-allowlist and host claims do not enter the proposed executable entry.

A **new focused CI workflow** (`.github/workflows/research-authority-boundary.yml`) runs on PRs touching research, executable Registry v2, Bridge admission/dispatch/routing, Worker/runtime source, integrations or the boundary checks themselves. It executes the source audit, Registry v2 validation and policy tests, research-proposal regressions and the fabricated-candidate isolation tests. No production service or host profile is modified.

This is a strong **source-level regression boundary**, not formal proof of the absence of dynamic imports, a replacement for runtime admission tests, or a cryptographic signature verifier. Any new runtime path that legitimately needs a research artifact must use an explicitly reviewed, non-executing interface and must not weaken the boundary by suppressing the check; any new model/signature/host-authorization feature needs its own trusted implementation and tests.

## Maintainer commands

From the Git checkout, run `node scripts/check-research-authority.mjs`, `node scripts/validate-agent-registry.mjs`, `node --test scripts/agent-registry.test.mjs`, `python3 scripts/test_research_execution_boundary.py` and `python3 scripts/test_review_research_promotion.py`. These only inspect approved source or temporary test fixtures.

Related: [ownership](OWNERSHIP.md), [research promotion review](PROMOTION.md), [shared coding-harness context](HARNESSES.md), [agent registry owners](../../../agents/README.md).
