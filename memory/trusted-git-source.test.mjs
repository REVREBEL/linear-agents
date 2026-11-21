import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createTrustedGitSourceVerifier } from "./trusted-git-source.mjs";

const REPO = "REVREBEL/linear-agents";
const CONTENT = "Verified rule: prepare each patch from a clean Git worktree.";
const SOURCE_PATH = "docs/verified-learnings/abr-59.txt";
function git(root, ...args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "abr59-git-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Verification Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "remote", "add", "origin", "https://github.com/REVREBEL/linear-agents.git");
    await mkdir(path.join(root, "docs/verified-learnings"), { recursive: true });
    await writeFile(path.join(root, SOURCE_PATH), CONTENT);
    git(root, "add", SOURCE_PATH);
    git(root, "commit", "-qm", "Verified short learning");
    const sha = git(root, "rev-parse", "HEAD");
    const scope = { tenantId: "tenant", agentId: "agent",
      repositoryId: REPO, issueId: "ABR-59" };
    const verify = createTrustedGitSourceVerifier({ repositories: { [REPO]: root } });
    const candidate = { scope, sourceGitSha: sha, headSha: sha,
      sourcePath: SOURCE_PATH, revision: 1, content: CONTENT,
      receiptId: "a".repeat(64) };
    return await run({ root, sha, scope, candidate, verify });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("attests exact short file from reviewed Git object, not working-tree copy", async () => {
  await fixture(async ({ root, candidate, verify }) => {
    assert.equal(await verify(candidate), true);
    await writeFile(path.join(root, SOURCE_PATH), "mutated worktree contents");
    assert.equal(await verify(candidate), true);
    assert.equal(await verify({ ...candidate, content: "mutated worktree contents" }), false);
  });
});
test("rejects wrong commit and independently modified source bytes", async () => {
  await fixture(async ({ candidate, verify }) => {
    for (const patch of [
      { sourceGitSha: "b".repeat(40) },
      { headSha: "b".repeat(40) },
      { content: CONTENT + " unrelated" },
      { sourcePath: "docs/verified-learnings/missing.txt" },
      { revision: 2 },
      { sourcePath: "../secrets.txt" },
      { sourcePath: "README.md" },
      { sourcePath: "docs/verified-learnings/../../secrets.txt" },
      { receiptId: "not-a-digest" },
    ]) assert.equal(await verify({ ...candidate, ...patch }), false);
  });
});
test("rejects mismatched origin and untrusted repository lookup", async () => {
  await fixture(async ({ root, candidate, verify }) => {
    assert.equal(await verify({ ...candidate,
      scope: { ...candidate.scope, repositoryId: "other/repo" } }), false);
    git(root, "remote", "set-url", "origin", "https://github.com/other/repo.git");
    assert.equal(await verify(candidate), false);
  });
});
test("rejects symlinked Git entries and nonregular source files", async () => {
  await fixture(async ({ root, sha, candidate, verify }) => {
    const { symlink, unlink } = await import("node:fs/promises");
    await unlink(path.join(root, SOURCE_PATH));
    await symlink("another.txt", path.join(root, SOURCE_PATH));
    git(root, "add", SOURCE_PATH);
    git(root, "commit", "-qm", "Replace note with symlink");
    const linkedSha = git(root, "rev-parse", "HEAD");
    assert.equal(await verify({ ...candidate,
      headSha: linkedSha, sourceGitSha: linkedSha,
      content: "another.txt" }), false);
    assert.equal(await verify({ ...candidate, headSha: sha, sourceGitSha: sha }), true);
  });
});
test("snapshots original source values before asynchronous Git commands", async () => {
  await fixture(async ({ candidate, root }) => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { started = resolve; });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const call = promisify(execFile);
    let first = true;
    const verify = createTrustedGitSourceVerifier({
      repositories: { [REPO]: root },
      execImpl: async (...args) => {
        if (first) { first = false; started(); await gate; }
        return call(...args);
      },
    });
    const mutable = structuredClone(candidate);
    const inFlight = verify(mutable);
    await began;
    mutable.content = "Changed after verification started";
    mutable.sourcePath = "docs/verified-learnings/other.txt";
    mutable.scope.repositoryId = "other/repo";
    release();
    assert.equal(await inFlight, true);
  });
});
test("requires trusted absolute repository mapping and rejects unsafe git inputs", async () => {
  assert.throws(() => createTrustedGitSourceVerifier({
    repositories: { [REPO]: "../relative" },
  }), /unavailable/);
  await fixture(async ({ candidate, verify }) => {
    assert.equal(await verify({ ...candidate, content: "x".repeat(601) }), false);
    assert.equal(await verify({ ...candidate, scope: { ...candidate.scope,
      repositoryId: REPO + ";echo bad" } }), false);
  });
});

test("real Git attestation authorizes M6 signing only for exact reviewed content", async () => {
  await fixture(async ({ root, sha, scope, verify }) => {
    const { randomBytes } = await import("node:crypto");
    const { createApprovedSourceStore } = await import("./approved-source-store.mjs");
    const { promotionReceiptId } = await import("./promotion-journal.mjs");
    const approvalRoot = path.join(root, "approvals");
    await mkdir(approvalRoot, { mode: 0o700 });
    const receipt = {
      scope, headSha: sha, prNumber: 258,
      state: "verified-awaiting-executor",
      proof: { status: "verified-after-merge",
        headSha: sha, mergeCommitSha: "b".repeat(40) },
    };
    receipt.id = promotionReceiptId(receipt);
    const source = { scope, sourceGitSha: sha, sourcePath: SOURCE_PATH,
      content: CONTENT, revision: 1, expiresAt: "2027-01-01T00:00:00Z" };
    const journal = { async read() { return structuredClone(receipt); } };
    const store = createApprovedSourceStore({
      root: approvalRoot, key: randomBytes(32), journal,
      verifySource: verify,
    });
    const at = Date.parse("2026-11-20T00:00:00Z");
    const signed = await store.approve({ receipt, source, now: at });
    assert.equal(signed.created, true);
    await assert.rejects(store.approve({ receipt, source: {
      ...source, content: "Invented and unsigned source content.",
    }, now: at }), /source verification failed/);
    const loaded = await store.load({ scope, receiptIds: [receipt.id], now: at });
    assert.equal(loaded.approvedSources.get(receipt.id).content, CONTENT);
  });
});
