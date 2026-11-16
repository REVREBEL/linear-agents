# ABR-28 P5.3: Deployment Readiness and End-to-End Validation

## What is verified, and what is not

P5.2 (repository structure consolidation) is merged into `main`. This first P5.3 milestone adds a **read-only source readiness audit** and CI tests. It does not upgrade Ubuntu, restart systemd, contact the Mac, post a Linear issue, or verify production delivery.

The distinction is intentional:

| Gate | Evidence | Status after this PR |
| --- | --- | --- |
| Source integrity | `npm run bridge:readiness`, `npm run test:reliability` | Automated in CI |
| Already-running Ubuntu bridge health | `npm run bridge:smoke` on Ubuntu with approved environment loaded | Requires operator run |
| Deployment commit and service binary | Record systemd ExecStart, working directory, `git rev-parse HEAD`, Node version | Requires operator run |
| Linux local provider launch and Linear progress | Dedicated non-customer test issue/session; observe accepted, running, progress, terminal | Not yet executed |
| Mac Trae SSH acceptance and callback | Controlled test issue; SSH runner ACK, tokenized activity, confirmed completion | Not yet executed |
| Duplicate and retry cases | Scoped replay using test delivery ID, observe original job ID and ledger state | Not yet executed live |
| Supervised restart/recovery | Approved window; reconcile interrupted jobs without duplicate launches | Requires separate approval |
| Runtime data move to `/var/lib/agent-bridge` | Backup, owner and ACL verification, atomic rollback and explicit cutover | Separate migration, not included |

## 1. CI source audit (safe on any checkout)

```sh
npm run bridge:readiness
npm run test:reliability
```

The readiness script checks ten invariants: legacy loader, canonical runtime path, systemd user/entrypoint configuration, environment wrapper, Mac loader, loopback diagnostics, remote SSH ACK, Mac callback capabilities, durable ledger and authenticated diagnostic handler. It reads only repository source, never service or credential contents. A passing result does **not** establish that the running Ubuntu process has loaded the merged code.

## 2. Current Ubuntu runtime inspection (read-only, no restart)

On the actual Ubuntu host, first confirm your Git checkout and service installation location. Do not assume the service's `WorkingDirectory` matches the location of your interactive repository checkout.

```sh
sudo -n systemctl status agent-bridge --no-pager
systemctl show agent-bridge -p User -p Group -p WorkingDirectory -p ExecStart -p MainPID
git rev-parse HEAD
git status --short
node --version
```

Inspect `ExecStart` carefully: the intended systemd installer uses `scripts/with-env.sh bridge`, which loads `linear-agent-bridge/agent-bridge.mjs` and imports `bridge/server/agent-bridge-runtime.mjs`. The source implementation resolves `PROJECT_DIR` from the old loader path to preserve `linear-agent-bridge/linear-jobs/`.

If the live service was installed from a different root, is not running as the `bridge` account, or has a different executable command, **stop the validation**, record the discrepancy, and do not restart/reinstall automatically.

## 3. Existing live loopback smoke (operator-run only)

With the authorized existing `BRIDGE_SHARED_SECRET` available in the command process environment, run the separate `npm run bridge:smoke` command from the service host. It connects to `127.0.0.1` only and checks health, unauthenticated rejection and a valid diagnostic probe. Do not paste secret output or its value into issues, chat, terminal screenshots or runbooks.

A passed smoke check verifies the running listener but still does not prove any agent launch or Linear callback.

## 4. Controlled issue lifecycle acceptance

Before sending an execution job, identify a dedicated test Linear issue, a non-customer test repository/workspace, permitted agent identities, and the corresponding Worker. Capture issue and session IDs, webhook delivery ID, bridge job key and timestamps in a private operator evidence log (never access tokens, SSH keys or callback capabilities).

Verify, in order:

1. Worker accepts a real signed Linear webhook and logs a correlation/delivery ID.
2. Ubuntu bridge records the delivery as a single durable claimed job.
3. The intended provider starts once and produces a verified running acknowledgement.
4. Progress is visible in **Linear**, not merely local logs.
5. Terminal callback is authenticated and reflected in both Linear and the Ubuntu ledger.
6. A duplicate delivery is not relaunched; ambiguous interrupted work requires explicit reconciliation.
7. Error, timeout, SSH transport failure and missing/corrupt callback cases do not falsely report completion.

For Mac Trae specifically, distinguish an SSH process start from `REMOTE_ACCEPTED:<jobId>` and distinguish a runner exit from an authenticated `/trae-complete` confirmation. A nonzero SSH exit cannot be counted as success.

## 5. Rollback boundaries

Do not restart services, deploy Workers, rotate credentials, move `linear-jobs/`, or change the SSH command as part of a read-only readiness check. Production deployment and restart require a separately approved change window, a backup of the current job ledger, verified old and new commit IDs and an explicit rollback path.

**P5.3 is only fully complete when the controlled Linear-to-Worker-to-Ubuntu-to-provider-to-Linear chain has been observed with evidence.** This PR establishes the deployment-readiness prerequisite, not that outcome.
