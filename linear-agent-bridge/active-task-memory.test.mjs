import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  createActiveTaskMemory,
  isCheckpointExpired,
  deriveStatusFromState,
  isSensitiveKey,
  validateStateStatusCompatibility,
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
    const files = await readdir(path.join(root, "active-task-memory"));
    assert.equal(files.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checkpoint preserves operational keys and redacts sensitive keys and embedded secrets both in-memory and on-disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "REV-177";
    const result = await store.update(repo, issue, {
      state: "active",
      lastJobKey: "job-operational-key-12345",
      idempotencyKey: "idem-key-abcde-67890",
      apiKey: "super-secret-api-key",
      password: "secret-password",
      nested: {
        token: "nested-token-val",
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
    assert.equal(result.apiKey, "[REDACTED]", "apiKey must be redacted");
    assert.equal(result.password, "[REDACTED]", "password must be redacted");
    assert.equal(result.nested.token, "[REDACTED]", "nested.token must be redacted");
    assert.equal(result.nested.regularKey, "should-stay-intact", "non-sensitive keys must remain intact");
    assert.equal(result.artifacts[0].key, "artifact-key-1", "nested non-secret key must remain intact");
    assert.equal(result.artifacts[1].authHeader, "Bearer [REDACTED]", "embedded Bearer token must be sanitized");
    assert.match(result.nextAction, /Bearer \[REDACTED\]/);
    assert.match(result.lastVerifiedResult, /\[REDACTED_GITHUB_TOKEN\]/);

    // 2. Fresh store instance read verification
    const freshStore = createActiveTaskMemory(root);
    const persisted = await freshStore.read(repo, issue);
    assert.equal(persisted.lastJobKey, "job-operational-key-12345");
    assert.equal(persisted.idempotencyKey, "idem-key-abcde-67890");
    assert.equal(persisted.apiKey, "[REDACTED]");
    assert.equal(persisted.nested.token, "[REDACTED]");
    assert.equal(persisted.nested.regularKey, "should-stay-intact");
    assert.equal(persisted.artifacts[1].authHeader, "Bearer [REDACTED]");

    // 3. Raw file-on-disk inspection to guarantee persistence of redactions
    const hash = crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");
    const rawContent = await readFile(path.join(root, "active-task-memory", `${hash}.json`), "utf8");
    const parsedRaw = JSON.parse(rawContent);
    assert.equal(parsedRaw.lastJobKey, "job-operational-key-12345");
    assert.equal(parsedRaw.apiKey, "[REDACTED]");
    assert.equal(parsedRaw.nested.token, "[REDACTED]");
    assert.ok(!rawContent.includes("super-secret-api-key"), "raw disk file must never contain secret string");
    assert.ok(!rawContent.includes("nested-token-val"), "raw disk file must never contain nested secret");
    assert.ok(!rawContent.includes("lin_oauth_0123456789abcdef0123456789"), "raw disk file must not contain raw Linear token");
    assert.ok(!rawContent.includes("ghp_0123456789abcdef0123456789abcdef"), "raw disk file must not contain raw GitHub token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle status derives consistently from state on dispatch and completion transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-STATE-TEST";

    // Dispatch transition: state = active -> status = active
    const dispatch = await store.update(repo, issue, { state: "active" });
    assert.equal(dispatch.state, "active");
    assert.equal(dispatch.status, "active");

    // Success completion: state = agent-finished -> status = completed
    const success = await store.update(repo, issue, { state: "agent-finished" });
    assert.equal(success.state, "agent-finished");
    assert.equal(success.status, "completed");

    // Failure / recovery: state = needs-recovery -> status = needs-recovery
    const failed = await store.update(repo, issue, { state: "needs-recovery" });
    assert.equal(failed.state, "needs-recovery");
    assert.equal(failed.status, "needs-recovery");

    // Explicit status override is respected
    const custom = await store.update(repo, issue, { status: "custom-status" });
    assert.equal(custom.status, "custom-status");

    // Helper unit check
    assert.equal(deriveStatusFromState("active"), "active");
    assert.equal(deriveStatusFromState("agent-finished"), "completed");
    assert.equal(deriveStatusFromState("needs-recovery"), "needs-recovery");
    assert.equal(deriveStatusFromState("other"), "other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compare-and-swap (CAS) revision validation accepts expected revision and rejects stale updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-CAS-TEST";

    // Initial update: initial revision is 0, passes with expectedRevision: 0
    const first = await store.update(repo, issue, { state: "active" }, { expectedRevision: 0 });
    assert.equal(first.revision, 1);

    // Second update: expected revision 1 matches current revision 1
    const second = await store.update(repo, issue, { nextAction: "step-2" }, { expectedRevision: 1 });
    assert.equal(second.revision, 2);

    // Third update with stale expected revision (0 instead of 2) throws ECONFLICT
    await assert.rejects(
      async () => {
        await store.update(repo, issue, { nextAction: "conflict-step" }, { expectedRevision: 0 });
      },
      (err) => {
        assert.equal(err.code, "ECONFLICT");
        assert.match(err.message, /Revision conflict/);
        return true;
      }
    );

    // Also supports expectedRevision inside patch object
    await assert.rejects(
      async () => {
        await store.update(repo, issue, { nextAction: "conflict-step", expectedRevision: 1 });
      },
      (err) => {
        assert.equal(err.code, "ECONFLICT");
        return true;
      }
    );

    // Verify checkpoint remained at revision 2 without applying rejected updates
    const current = await store.read(repo, issue);
    assert.equal(current.revision, 2);
    assert.equal(current.nextAction, "step-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint expiration enforces staleness in recovery preamble and helpers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-active-"));
  try {
    const store = createActiveTaskMemory(root);
    const repo = "/workspace/project";
    const issue = "ISSUE-EXPIRY-DISCLOSURE";

    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

    // Expired record
    const expiredRecord = await store.update(repo, issue, {
      state: "active",
      nextAction: "execute-legacy-step",
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
      nextAction: "execute-current-step",
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
