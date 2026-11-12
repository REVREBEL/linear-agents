# Migration, deployment and release work orders

Use for staging certification, live catalog cutovers, project materialization, provider exports, deployment and rollback. This type has the strictest authorization requirements.

1. **Classify action:** evidence-only dry run, isolated staging, approved live migration, or approved runtime publication. A readiness result does not grant approval for the next action.
2. Establish target snapshot SHA, source/destination boundaries, affected objects, dependencies, backups, integrity manifests, rollback journal, operational checks and explicit named authorization for each live stage.
3. Never elevate a migration-authorization flag just to satisfy an assertion. Confirm actual tool side effects before executing.
4. For manifests and resources, verify digests; for router/dependency changes, reference closure; for compiled output, determinism where specified; for gates, record each exact gate outcome and blocker.
5. **PASS** for staging means evidence and required gates pass in isolation. **PASS** for live work requires separate approval, monitored outcome, rollback readiness and post-action verification. Never conflate them.
6. Stop on failed preflight, missing authorization, unexpected writes or source mismatch; record failure and escalate without proceeding.
