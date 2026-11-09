import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  createActiveTaskMemory,
  isCheckpointExpired,
  deriveStatusFromState,
  isSensitiveKey,
  isProcessAlive,
  validateStateStatusCompatibility,
  withCrossProcessLock,
} from "./active-task-memory.mjs";

test("active memory survives bridge restart and restores issue-scoped context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const first = createActiveTaskMemory(root);
    await first.update("/workspace/repo", "issue-12345678", {
      lastAgent: "antigravity",
      state: "active",
      lastSessionId: "session-abc123",
      lastVerifiedResult: "Tests not yet verified",
    });
    const second = createActiveTaskMemory(root);
    const previous = await second.read("/workspace/repo", "issue-12345678");
    assert.equal(previous.lastAgent, "antigravity");
    assert.equal(previous.lastVerifiedResult, "Tests not yet verified");
    assert.match(second.recoveryPreamble(previous), /Inspect the repository and tests/);
    assert.equal(await second.read("/workspace/repo2", "issue-12345678"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent updates serialize and never leave truncated checkpoint files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.update("repo", "issue-12345678", {
          lastVerifiedResult: "stage-" + i,
        })
      )
    );
    assert.equal((await store.read("repo", "issue-12345678")).lastVerifiedResult, "stage-7");
    const files = (await readdir(path.join(root, "active-task-memory"))).filter(f => f.endsWith(".json"));
    assert.equal(files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("camelCase secret redaction and raw on-disk persistence check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "REV-177";

    const secretAccessToken = "arbitrary-secret-token-value-12345";
    const secretRefreshToken = "arbitrary-refresh-token-value-67890";
    const secretClientSecret = "arbitrary-client-secret-value-abcde";
    const secretAuthHeader = "ArbitraryScheme arbitrary-auth-payload-xyz";
    const secretPasswordHash = "argon2id-arbitrary-hashed-secret-99999";
    const nestedSecret = "nested-arbitrary-secret-val";

    // Unit test helper for camelCase key matching
    assert.equal(isSensitiveKey("accessToken"), true);
    assert.equal(isSensitiveKey("refreshToken"), true);
    assert.equal(isSensitiveKey("clientSecret"), true);
    assert.equal(isSensitiveKey("authorizationHeader"), true);
    assert.equal(isSensitiveKey("passwordHash"), true);
    assert.equal(isSensitiveKey("lastJobKey"), false, "lastJobKey must never be sensitive");
    assert.equal(isSensitiveKey("idempotencyKey"), false, "idempotencyKey must never be sensitive");
    assert.equal(isSensitiveKey("regularProperty"), false);

    const result = await store.update(repo, issue, {
      state: "active",
      lastJobKey: "job-operational-key-12345",
      idempotencyKey: "idem-key-abcde-67890",
      accessToken: secretAccessToken,
      refreshToken: secretRefreshToken,
      clientSecret: secretClientSecret,
      authorizationHeader: secretAuthHeader,
      passwordHash: secretPasswordHash,
      nested: {
        token: nestedSecret,
        regularKey: "should-stay-intact",
      },
      artifacts: [
        { name: "test-run", key: "artifact-key-1" },
        { authHeader: "Bearer lin_oauth_0123456789abcdef0123456789" },
      ],
      nextAction: "Dispatching task with Bearer lin_oauth_0123456789abcdef0123456789 to internal runner",
      lastVerifiedResult: "Verified commit 6e75d7e using token ghp_0123456789abcdef0123456789abcdef",
    });

    // 1. In-memory returned object verification
    assert.equal(result.lastJobKey, "job-operational-key-12345", "lastJobKey must NOT be redacted");
    assert.equal(result.idempotencyKey, "idem-key-abcde-67890", "idempotencyKey must NOT be redacted");
    assert.equal(result.accessToken, "[REDACTED]");
    assert.equal(result.refreshToken, "[REDACTED]");
    assert.equal(result.clientSecret, "[REDACTED]");
    assert.equal(result.authorizationHeader, "[REDACTED]");
    assert.equal(result.passwordHash, "[REDACTED]");
    assert.equal(result.nested.token, "[REDACTED]");
    assert.equal(result.nested.regularKey, "should-stay-intact");
    assert.equal(result.artifacts[0].key, "artifact-key-1");
    assert.equal(result.artifacts[1].authHeader, "[REDACTED]");
    assert.match(result.nextAction, /Bearer \[REDACTED\]/);
    assert.match(result.lastVerifiedResult, /\[REDACTED_GITHUB_TOKEN\]/);

    // 2. Fresh store instance read verification
    const freshStore = createActiveTaskMemory(root);
    const persisted = await freshStore.read(repo, issue);
    assert.equal(persisted.lastJobKey, "job-operational-key-12345");
    assert.equal(persisted.accessToken, "[REDACTED]");
    assert.equal(persisted.refreshToken, "[REDACTED]");
    assert.equal(persisted.clientSecret, "[REDACTED]");
    assert.equal(persisted.authorizationHeader, "[REDACTED]");
    assert.equal(persisted.passwordHash, "[REDACTED]");
    assert.equal(persisted.nested.token, "[REDACTED]");

    // 3. Raw disk file inspection to guarantee absolute non-persistence of arbitrary secret values
    const hash = crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");
    const rawContent = await readFile(path.join(root, "active-task-memory", `${hash}.json`), "utf8");
    assert.ok(!rawContent.includes(secretAccessToken), "accessToken must not be in raw file");
    assert.ok(!rawContent.includes(secretRefreshToken), "refreshToken must not be in raw file");
    assert.ok(!rawContent.includes(secretClientSecret), "clientSecret must not be in raw file");
    assert.ok(!rawContent.includes(secretAuthHeader), "authorizationHeader must not be in raw file");
    assert.ok(!rawContent.includes(secretPasswordHash), "passwordHash must not be in raw file");
    assert.ok(!rawContent.includes(nestedSecret), "nested secret must not be in raw file");
    assert.ok(!rawContent.includes("lin_oauth_0123456789abcdef0123456789"), "embedded linear token must not be in raw file");
    assert.ok(!rawContent.includes("ghp_0123456789abcdef0123456789abcdef"), "embedded github token must not be in raw file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-process and independent instance transactional CAS write safety", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store1 = createActiveTaskMemory(root);
    const store2 = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-CROSS-PROCESS-CAS";

    // Initial write via store1
    const initial = await store1.update(repo, issue, { state: "active" });
    assert.equal(initial.revision, 1);

    // Both independent instances read revision 1 from disk
    const read1 = await store1.read(repo, issue);
    const read2 = await store2.read(repo, issue);
    assert.equal(read1.revision, 1);
    assert.equal(read2.revision, 1);

    // store1 updates with expectedRevision: 1 -> succeeds, revision advances to 2
    const updated1 = await store1.update(repo, issue, { nextAction: "from-store1" }, { expectedRevision: 1 });
    assert.equal(updated1.revision, 2);

    // store2 attempts to update with stale expectedRevision: 1 -> rejected with ECONFLICT
    await assert.rejects(
      async () => {
        await store2.update(repo, issue, { nextAction: "from-store2" }, { expectedRevision: 1 });
      },
      (err) => {
        assert.equal(err.code, "ECONFLICT");
        assert.equal(err.expectedRevision, 1);
        assert.equal(err.currentRevision, 2);
        return true;
      }
    );

    // Concurrent race test between two independent store instances
    const current = await store1.read(repo, issue);
    assert.equal(current.revision, 2);

    const [raceRes1, raceRes2] = await Promise.allSettled([
      store1.update(repo, issue, { nextAction: "race-candidate-1" }, { expectedRevision: 2 }),
      store2.update(repo, issue, { nextAction: "race-candidate-2" }, { expectedRevision: 2 }),
    ]);

    // Exactly one must succeed and one must be rejected with ECONFLICT
    const fulfilled = [raceRes1, raceRes2].filter(r => r.status === "fulfilled");
    const rejected = [raceRes1, raceRes2].filter(r => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "Exactly one concurrent CAS update must succeed");
    assert.equal(rejected.length, 1, "Exactly one concurrent CAS update must be rejected");
    assert.equal(rejected[0].reason.code, "ECONFLICT");

    // Final revision on disk must be 3
    const finalRecord = await store2.read(repo, issue);
    assert.equal(finalRecord.revision, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe cross-process ownership: no lock stealing from live writer held > 10s and safe release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-proc-lock-"));
  const readyFile = path.join(root, "ready.txt");
  const repo = "/workspace/project";
  const issue = "ISSUE-SEPARATE-PROC";

  // Liveness helper sanity checks
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(9999999), false);

  // Spawn separate OS Process A that holds lock for 10.5 seconds (> 10s staleThreshold)
  const childA = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { createActiveTaskMemory } from "./linear-agent-bridge/active-task-memory.mjs";
      import fs from "node:fs/promises";
      const [root, readyFile, repo, issue] = process.argv.slice(1);
      const store = createActiveTaskMemory(root);
      await store.update(repo, issue, { state: "active", nextAction: "child-a-in-flight" }, {
        _holdLockMs: 10500,
        _onLockAcquired: async () => {
          await fs.writeFile(readyFile, "ready");
        }
      });
      process.exit(0);
      `,
      root,
      readyFile,
      repo,
      issue,
    ],
    { cwd: path.resolve(import.meta.dirname, "..") }
  );

  try {
    // Wait for Child Process A to acquire the lock and signal readiness
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await readFile(readyFile);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(ready, "Child Process A must have acquired lock and signaled ready");

    // Process B (this process) attempts update while A is still holding the lock.
    // It must NOT steal the lock even though A holds it, and must time out with ELOCKED.
    const storeB = createActiveTaskMemory(root);
    await assert.rejects(
      async () => {
        await storeB.update(
          repo,
          issue,
          { nextAction: "contender-b-blocked" },
          { lockTimeoutMs: 250, retryIntervalMs: 25 }
        );
      },
      (err) => {
        assert.equal(err.code, "ELOCKED");
        assert.match(err.message, /Lock acquisition timed out/);
        return true;
      }
    );

    // Wait for Child Process A to finish its critical section (> 10s) and exit cleanly
    const childExitCode = await new Promise((resolve) => childA.on("exit", resolve));
    assert.equal(childExitCode, 0, "Child Process A must exit with code 0");

    // Now that Process A has completed and safely released the lock,
    // Process C can now acquire the lock cleanly and update to revision 2!
    const storeC = createActiveTaskMemory(root);
    const recordAfterA = await storeC.read(repo, issue);
    assert.equal(recordAfterA.revision, 1);
    assert.equal(recordAfterA.nextAction, "child-a-in-flight");

    const recordC = await storeC.update(
      repo,
      issue,
      { nextAction: "contender-c-succeeded" },
      { expectedRevision: 1 }
    );
    assert.equal(recordC.revision, 2);
    assert.equal(recordC.nextAction, "contender-c-succeeded");
  } finally {
    childA.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("competing reclaimers cannot steal or remove a successor's live lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-reclaim-race-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-COMPETING-RECLAIMERS";
    const hash = crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");
    const lockDir = path.join(root, "active-task-memory", `${hash}.json.lock`);
    await fs.mkdir(path.join(root, "active-task-memory"), { recursive: true });

    // Step 1: Simulate a stale lock from a dead process A
    await fs.mkdir(lockDir);
    const deadNonce = "dead-nonce-1111";
    const deadOwnerFile = path.join(lockDir, `${deadNonce}.owner`);
    await writeFile(
      deadOwnerFile,
      JSON.stringify({ nonce: deadNonce, pid: 9999999, hostname: os.hostname(), createdAt: Date.now() })
    );

    // Contender 1 inspects lockDir and observes dead process A
    const entries = await fs.readdir(lockDir);
    assert.equal(entries[0], `${deadNonce}.owner`);

    // Step 2: Between Contender 1's observation and reclamation attempt, Contender 2 reclaims and establishes Live Lock B
    // Contender 2 unlinks the dead owner file, rmdirs lockDir, and acquires lockDir with its live PID
    await fs.unlink(deadOwnerFile);
    await fs.rmdir(lockDir);
    await fs.mkdir(lockDir);
    const liveNonce = "live-nonce-2222";
    const liveOwnerFile = path.join(lockDir, `${liveNonce}.owner`);
    await writeFile(
      liveOwnerFile,
      JSON.stringify({ nonce: liveNonce, pid: process.pid, hostname: os.hostname(), createdAt: Date.now() })
    );

    // Step 3: Now Contender 1 attempts to reclaim based on its stale observation of dead owner A
    // It must NOT remove liveOwnerFile and must NOT remove lockDir!
    await assert.rejects(
      async () => {
        await fs.unlink(deadOwnerFile);
      },
      { code: "ENOENT" }
    );

    // Attempting to rmdir lockDir throws ENOTEMPTY because Live Lock B is inside
    await assert.rejects(
      async () => {
        await fs.rmdir(lockDir);
      },
      { code: "ENOTEMPTY" }
    );

    // Verify Live Lock B is completely preserved and untouched
    const currentEntries = await fs.readdir(lockDir);
    assert.equal(currentEntries.length, 1);
    assert.equal(currentEntries[0], `${liveNonce}.owner`);
    const liveContent = await readFile(liveOwnerFile, "utf8");
    assert.equal(JSON.parse(liveContent).nonce, liveNonce);

    // Attempting update via store times out because live owner B is alive!
    await assert.rejects(
      async () => {
        await store.update(repo, issue, { nextAction: "contender-1-attempt" }, { lockTimeoutMs: 150, retryIntervalMs: 25 });
      },
      { code: "ELOCKED" }
    );

    // Clean up live lock
    await fs.unlink(liveOwnerFile);
    await fs.rmdir(lockDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe release unlinks owner nonce and rmdirs lock directory without touching foreign files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-safe-rel-"));
  try {
    const fakeLockDir = path.join(root, "fake.lock");
    await withCrossProcessLock(fakeLockDir, async () => {
      // While locked, plant a foreign file inside fakeLockDir
      const foreignFile = path.join(fakeLockDir, "foreign-owner.owner");
      await writeFile(foreignFile, JSON.stringify({ nonce: "foreign-nonce", pid: process.pid }));
    });
    // The lock directory must NOT be deleted because foreign file is present (rmdir fails with ENOTEMPTY)
    const exists = await fs.stat(fakeLockDir).then(() => true, () => false);
    assert.equal(exists, true, "lockDir must be preserved when containing foreign file");
    const foreignExists = await fs.stat(path.join(fakeLockDir, "foreign-owner.owner")).then(() => true, () => false);
    assert.equal(foreignExists, true, "foreign owner file must never be deleted by another owner release");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle status validation, non-divergence, and strict unknown rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-STATUS-CONTRACT";

    // 1. Strict rejection of unknown status
    assert.throws(
      () => validateStateStatusCompatibility("active", "totally-custom"),
      (err) => {
        assert.equal(err.code, "EINVAL_STATE_STATUS");
        assert.match(err.message, /Unknown lifecycle status "totally-custom"/);
        return true;
      }
    );

    // Strict rejection of unknown state
    assert.throws(
      () => validateStateStatusCompatibility("invalid-state", "active"),
      (err) => {
        assert.equal(err.code, "EINVAL_STATE_STATUS");
        assert.match(err.message, /Unknown lifecycle state "invalid-state"/);
        return true;
      }
    );

    // 2. Incompatible state and status combination is rejected
    assert.throws(
      () => validateStateStatusCompatibility("active", "completed"),
      (err) => {
        assert.equal(err.code, "EINVAL_STATE_STATUS");
        assert.match(err.message, /Incompatible lifecycle status "completed" for state "active"/);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await store.update(repo, issue, { state: "active", status: "completed" });
      },
      (err) => {
        assert.equal(err.code, "EINVAL_STATE_STATUS");
        return true;
      }
    );

    // 3. Normal dispatch transition: state = active -> status = active
    const dispatch = await store.update(repo, issue, { state: "active" });
    assert.equal(dispatch.state, "active");
    assert.equal(dispatch.status, "active");

    // 4. Subsequent update without state or status preserves both consistently
    const intermediate = await store.update(repo, issue, { nextAction: "intermediate-task" });
    assert.equal(intermediate.state, "active");
    assert.equal(intermediate.status, "active");

    // 5. Normal completion: state = agent-finished -> status = completed
    const completion = await store.update(repo, issue, { state: "agent-finished" });
    assert.equal(completion.state, "agent-finished");
    assert.equal(completion.status, "completed");

    // 6. Subsequent update after completion retains completed status
    const postCompletion = await store.update(repo, issue, { artifacts: [{ name: "diff" }] });
    assert.equal(postCompletion.state, "agent-finished");
    assert.equal(postCompletion.status, "completed");

    // 7. Normal recovery: state = needs-recovery -> status = needs-recovery
    const recovery = await store.update(repo, issue, { state: "needs-recovery" });
    assert.equal(recovery.state, "needs-recovery");
    assert.equal(recovery.status, "needs-recovery");

    // Helper checks
    assert.equal(deriveStatusFromState("active"), "active");
    assert.equal(deriveStatusFromState("agent-finished"), "completed");
    assert.equal(deriveStatusFromState("needs-recovery"), "needs-recovery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint expiration completely suppresses stale nextAction content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-EXPIRY-DISCLOSURE";

    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const sensitiveOldInstruction = "rm -rf unverified-path && run-legacy-migration";

    const expiredRecord = await store.update(repo, issue, {
      state: "active",
      nextAction: sensitiveOldInstruction,
      expiresAt: pastDate,
    });

    assert.equal(isCheckpointExpired(expiredRecord), true);
    const expiredPreamble = store.recoveryPreamble(expiredRecord);

    // Verify complete suppression of the stale instruction text
    assert.ok(
      !expiredPreamble.includes(sensitiveOldInstruction),
      "expired preamble must NEVER disclose the stale action text"
    );
    assert.match(expiredPreamble, /STALE/);
    assert.match(expiredPreamble, /Next action: none \(suppressed due to checkpoint expiration\)/);
    assert.match(expiredPreamble, /A live Linear\/GitHub\/checkout refresh is REQUIRED/);
    assert.match(expiredPreamble, /Previous state: expired \(stale active\)/);

    // Non-expired record reveals nextAction normally
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const activeRecord = await store.update(repo, issue, {
      state: "active",
      nextAction: "execute-fresh-step",
      expiresAt: futureDate,
    });
    assert.equal(isCheckpointExpired(activeRecord), false);
    const activePreamble = store.recoveryPreamble(activeRecord);
    assert.match(activePreamble, /Next action: execute-fresh-step/);
    assert.ok(!activePreamble.includes("STALE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress events are bounded, redacted, and survive restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-progress-"));
  try {
    const mem = createActiveTaskMemory(root);
    await Promise.all(Array.from({ length: 31 }, (_, i) =>
      mem.progress("repo", "issue-0123", {
        kind: "tool", summary: "Step " + i + ": edit_file API_KEY=supersecret"
      })));
    const latest = await createActiveTaskMemory(root).read("repo", "issue-0123");
    assert.equal(latest.progress.length, 20);
    assert.equal(latest.progress[0].summary.startsWith("Step 11:"), true);
    assert.ok(!JSON.stringify(latest).includes("supersecret"));
    const lines = mem.recoveryPreamble(latest).split("\n")
      .filter(line => line.startsWith("Checkpoint: tool"));
    assert.deepEqual(lines.map(line => Number(line.match(/Step (\\d+):/)?.[1])),
      [25, 26, 27, 28, 29, 30]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema v2 retains incremental progress, sanitizes nested credentials and enforces revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-versioned-memory-"));
  try {
    const store = createActiveTaskMemory(root);
    const first = await store.update("repo", "issue-123", {
      state: "active", nextAction: "Run tests",
      artifacts: [{ path: "src/index.ts", privateToken: "do-not-store" }],
      source: { kind: "linear", metadata: { authorizationHeader: "Bearer hidden" } },
      lastVerifiedResult: "ghp_12345678901234567890123456789012345",
    });
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.revision, 1);
    assert.equal(first.artifacts[0].privateToken, "[REDACTED]");
    assert.equal(first.source.metadata.authorizationHeader, "[REDACTED]");
    assert.ok(!JSON.stringify(first).includes("do-not-store"));
    assert.ok(!JSON.stringify(first).includes("ghp_12345678901234567890123456789012345"));
    await store.progress("repo", "issue-123", { kind: "checkpoint", summary: "Step complete" });
    const current = await store.read("repo", "issue-123");
    assert.equal(current.revision, 2);
    assert.equal(current.progress.length, 1);
    await assert.rejects(
      store.update("repo", "issue-123", { expectedRevision: 1, nextAction: "Stale overwrite" }),
      error => error.code === "ECONFLICT",
    );
    assert.equal((await store.read("repo", "issue-123")).nextAction, "Run tests");
    assert.match(store.recoveryPreamble(current), /Next action: Run tests/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired checkpoints omit stale next actions and lifecycle mismatch fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-expired-memory-"));
  try {
    const store = createActiveTaskMemory(root);
    const expired = await store.update("repo", "issue-expired", {
      expiresAt: "2025-01-01T00:00:00Z", nextAction: "Dangerous stale instruction",
    });
    const preamble = store.recoveryPreamble(expired);
    assert.match(preamble, /EXPIRED/);
    assert.doesNotMatch(preamble, /Dangerous stale instruction/);
    await assert.rejects(
      store.update("repo", "issue-expired", { state: "active", status: "completed" }),
      /Invalid checkpoint lifecycle/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate memory instances serialize concurrent progress using filesystem lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-crossproc-memory-"));
  try {
    const a = createActiveTaskMemory(root);
    const b = createActiveTaskMemory(root);
    await Promise.all([
      a.progress("repo", "issue-shared", { summary: "first" }),
      b.progress("repo", "issue-shared", { summary: "second" }),
    ]);
    const record = await a.read("repo", "issue-shared");
    assert.equal(record.progress.length, 2);
    assert.equal(record.revision, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
