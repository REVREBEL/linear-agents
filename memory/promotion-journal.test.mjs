import test from "node:test";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, chmod, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPromotionJournal, promotionReceiptId } from "./promotion-journal.mjs";

const sha = "a".repeat(40), mergeSha = "b".repeat(40);
const scope = { tenantId: "tenant-one", agentId: "qwen-local",
  repositoryId: "REVREBEL/linear-agents", issueId: "ABR-59" };
const pr = () => ({ number: 253, state: "closed", merged: true,
  head: { sha, repo: { full_name: scope.repositoryId } },
  base: { repo: { full_name: scope.repositoryId } },
  user: { login: "coder" }, merge_commit_sha: mergeSha });
const github = (patch = {}) => ({
  async getPullRequest() { return { ...pr(), ...(patch.pr || {}) }; },
  async listReviews() { return patch.reviews ?? [{
    id: 1, state: "APPROVED", commit_id: sha,
    submitted_at: "2026-11-20T07:00:00Z", user: { login: "reviewer" },
  }]; },
  async listCheckRuns() { return patch.checks ?? [{
    id: 2, name: "bridge-tests", head_sha: sha,
    app: { slug: "github-actions" }, status: "completed", conclusion: "success",
  }]; },
  async getCollaboratorPermission() { return { permission: "write" }; },
});
const args = client => ({ github: client, scope, prNumber: 253,
  expectedHeadSha: sha, requiredChecks: ["bridge-tests"],
  now: () => "2026-11-20T08:00:00Z" });
async function temp(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), "abr59-journal-"));
  try { return await run(path.join(base, "receipts")); }
  finally { await rm(base, { recursive: true, force: true }); }
}
test("fresh independent GitHub proof stages private crash-durable receipt only, never memU write", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    const created = await journal.stageVerified(args(github()));
    assert.equal(created.created, true);
    assert.equal(created.receipt.state, "verified-awaiting-executor");
    assert.equal(created.receipt.proof.approval.reviewer, "reviewer");
    assert.equal(created.receipt.headSha, sha);
    const files = await readdir(root);
    assert.equal(files.length, 1);
    assert.equal(files[0], created.receipt.id + ".json");
    assert.doesNotMatch(await readFile(path.join(root, files[0]), "utf8"), /password/);
    assert.deepEqual((await createPromotionJournal({ root }).listPending(scope))
      .map(x => x.id), [created.receipt.id]);
    assert.equal((await journal.read({ scope, prNumber: 253, headSha: sha })).id,
      created.receipt.id);
  });
});
test("idempotent replay preserves first receipt through restart", async () => {
  await temp(async root => {
    const original = await createPromotionJournal({ root }).stageVerified(args(github()));
    const replay = await createPromotionJournal({ root }).stageVerified({
      ...args(github()), now: () => "2026-11-21T00:00:00Z",
    });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.receipt, original.receipt);
    assert.equal((await readdir(root)).length, 1);
  });
});
test("failed, stale, unmerged and untrusted approval claims never stage", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    for (const client of [
      null,
      github({ pr: { merged: false } }),
      github({ reviews: [{ id: 1, state: "COMMENTED", commit_id: sha,
        submitted_at: "2026-11-20T07:00:00Z", user: { login: "reviewer" } }] }),
      github({ checks: [{ id: 3, name: "bridge-tests", head_sha: sha,
        app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }] }),
    ]) await assert.rejects(journal.stageVerified(args(client)), /Promotion refused/);
    assert.equal((await readdir(root)).length, 0);
  });
});
test("separate tenant, agent, repository and issue cannot read private receipt", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    await journal.stageVerified(args(github()));
    for (const key of Object.keys(scope)) {
      const foreign = { ...scope, [key]: "foreign" };
      assert.equal(await journal.read({ scope: foreign, prNumber: 253, headSha: sha }), null);
      assert.deepEqual(await journal.listPending(foreign), []);
    }
    assert.notEqual(promotionReceiptId({ scope, prNumber: 253, headSha: sha }),
      promotionReceiptId({ scope: { ...scope, issueId: "OTHER-1" },
        prNumber: 253, headSha: sha }));
  });
});
test("concurrent duplicate stage attempts can create only one receipt", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      journal.stageVerified(args(github()))));
    assert.equal(results.filter(x => x.created).length, 1);
    assert.equal((await readdir(root)).length, 1);
  });
});
test("private owner-controlled directory and receipt permissions fail closed", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    const item = await journal.stageVerified(args(github()));
    const file = path.join(root, item.receipt.id + ".json");
    await chmod(file, 0o644);
    await assert.rejects(journal.read({ scope, prNumber: 253, headSha: sha }),
      /insecure/);
    await chmod(file, 0o600);
    await chmod(root, 0o755);
    await assert.rejects(journal.listPending(scope), /private owned directory/);
  });
});
test("symlinked or corrupted receipts do not become trusted evidence", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    const item = await journal.stageVerified(args(github()));
    const file = path.join(root, item.receipt.id + ".json");
    const raw = await readFile(file, "utf8");
    const modified = JSON.parse(raw);
    modified.state = "committed";
    const { writeFile, unlink } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(modified));
    await assert.rejects(journal.read({ scope, prNumber: 253, headSha: sha }),
      /corrupt/);
    await unlink(file);
    const foreign = path.join(path.dirname(root), "untrusted");
    await writeFile(foreign, raw);
    await symlink(foreign, file);
    await assert.rejects(journal.read({ scope, prNumber: 253, headSha: sha }),
      /insecure/);
  });
});

test("orphaned incomplete staging files are invisible after a crash", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    await journal.stageVerified(args(github()));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(root, ".staging-crashed-write"), "{unclosed", { mode: 0o600 });
    assert.equal((await journal.listPending(scope)).length, 1);
    assert.equal((await journal.stageVerified(args(github()))).created, false);
  });
});

test("a receipt growing after stat is rejected with bounded I/O", async () => {
  await temp(async root => {
    const journal = createPromotionJournal({ root });
    const item = await journal.stageVerified(args(github()));
    const filename = path.join(root, item.receipt.id + ".json");
    const originalOpen = fs.open;
    let unboundedRead = false;
    try {
      fs.open = async (...openArgs) => {
        const handle = await originalOpen(...openArgs);
        const originalStat = handle.stat.bind(handle);
        const originalReadFile = handle.readFile.bind(handle);
        handle.stat = async (...statArgs) => {
          const result = await originalStat(...statArgs);
          await fs.appendFile(filename, "x".repeat(16385));
          return result;
        };
        handle.readFile = (...readArgs) => {
          unboundedRead = true;
          return originalReadFile(...readArgs);
        };
        return handle;
      };
      await assert.rejects(journal.read({ scope, prNumber: 253, headSha: sha }), /oversized journal/);
      assert.equal(unboundedRead, false, "must never use an unbounded read");
    } finally { fs.open = originalOpen; }
  });
});

test("new journal root and missing ancestors are synced in containing-parent order", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "abr59-parent-sync-"));
  try {
    const root = path.join(base, "nested-one", "nested-two", "receipts");
    const synced = [];
    const syncDir = async directory => {
      synced.push(directory);
      const handle = await import("node:fs/promises").then(m =>
        m.open(directory, m.constants.O_RDONLY | m.constants.O_DIRECTORY));
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const result = await createPromotionJournal({ root, syncDir })
      .stageVerified(args(github()));
    assert.equal(result.created, true);
    assert.deepEqual(synced, [
      base, path.join(base, "nested-one"),
      path.join(base, "nested-one", "nested-two"), root,
    ]);
    assert.equal((await createPromotionJournal({ root }).read({
      scope, prNumber: 253, headSha: sha,
    })).id, result.receipt.id);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test("failed parent-directory fsync prevents acknowledgement of publication", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "abr59-fsync-fail-"));
  try {
    const root = path.join(base, "missing-parent", "receipts");
    await assert.rejects(createPromotionJournal({ root, syncDir: async directory => {
      if (directory === base) throw Error("parent fsync failure");
    } }).stageVerified(args(github())), /parent fsync failure/);
    assert.deepEqual(await readdir(path.join(base, "missing-parent")), []);
  } finally { await rm(base, { recursive: true, force: true }); }
});
