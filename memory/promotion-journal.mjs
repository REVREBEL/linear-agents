import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyPromotionFromGitHub } from "./promotion-verification.mjs";

const SHA = /^[0-9a-f]{40}$/;
const IDENTITY_KEYS = ["tenantId", "agentId", "repositoryId", "issueId"];
const MAX_RECORD = 16384;
function deny(message) {
  throw Object.assign(new Error("Promotion journal refused: " + message),
    { code: "EPROMOTION_JOURNAL_DENIED" });
}
function scopeIdentity(scope) {
  if (!scope || !IDENTITY_KEYS.every(k =>
    typeof scope[k] === "string" && scope[k].length > 0 &&
    scope[k].length <= 512 && !/[\x00-\x1f\x7f]/.test(scope[k])))
    deny("invalid scope");
  return Object.fromEntries(IDENTITY_KEYS.map(k => [k, scope[k]]));
}
export function promotionReceiptId({ scope, prNumber, headSha }) {
  const identity = scopeIdentity(scope);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !SHA.test(headSha || ""))
    deny("invalid PR or commit");
  return createHash("sha256").update(JSON.stringify([
    ...IDENTITY_KEYS.map(k => identity[k]), prNumber, headSha,
  ])).digest("hex");
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(root, syncDir = syncDirectory) {
  if (!path.isAbsolute(root)) deny("journal root must be absolute");
  // mkdir(recursive:true) alone is not durable: sync each containing parent
  // immediately after its new child directory entry is published.
  const missing = [];
  let cursor = root;
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory()) deny("journal path component is not a directory");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) deny("journal parent cannot be resolved");
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await syncDir(path.dirname(directory));
  }
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
    deny("journal root must be a private owned directory");
}
function recordPath(root, id) { return path.join(root, id + ".json"); }
function assertRecord(record, id) {
  if (!record || record.schemaVersion !== 1 ||
      record.id !== id || record.state !== "verified-awaiting-executor" ||
      !record.proof || record.proof.status !== "verified-after-merge" ||
      record.proof.headSha !== record.headSha ||
      record.proof.prNumber !== record.prNumber ||
      record.proof.repository !== record.scope?.repositoryId ||
      !record.proof.approval || !Array.isArray(record.proof.checks) ||
      !record.proof.checks.length ||
      promotionReceiptId(record) !== id ||
      typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt)))
    deny("corrupt or untrusted journal receipt");
  return record;
}
async function readReceipt(root, id) {
  const filename = recordPath(root, id);
  const lst = await fs.lstat(filename);
  if (!lst.isFile() || lst.size > MAX_RECORD ||
      (lst.mode & 0o077) !== 0 ||
      (process.getuid && lst.uid !== process.getuid()))
    deny("insecure journal receipt");
  const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== lst.dev || stat.ino !== lst.ino ||
        stat.size > MAX_RECORD || (stat.mode & 0o077) !== 0)
      deny("journal file changed or insecure");
    // Cap actual I/O as well as the earlier stat: the file can grow between them.
    const buffer = Buffer.alloc(MAX_RECORD + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_RECORD) deny("oversized journal");
    return assertRecord(JSON.parse(buffer.toString("utf8", 0, used)), id);
  } finally { await handle.close(); }
}
/**
 * Durable, scope-isolated authorization receipt. Only the real authenticated
 * GitHub verifier is allowed to create records. There is NO memU mutation API.
 */
export function createPromotionJournal({ root, syncDir = syncDirectory }) {
  if (typeof root !== "string" || !path.isAbsolute(root) ||
      typeof syncDir !== "function")
    deny("journal root must be absolute");
  return Object.freeze({
    async stageVerified({
      github, scope, prNumber, expectedHeadSha, requiredChecks, allowedCheckApps,
      permittedReviewers, now = () => new Date().toISOString(),
    }) {
      await privateDirectory(root, syncDir);
      // Always reverify on every stage attempt, including duplicate receipts.
      const proof = await verifyPromotionFromGitHub({
        github, scope, prNumber, expectedHeadSha, requiredChecks,
        allowedCheckApps, permittedReviewers,
      });
      const identity = scopeIdentity(proof.scope);
      const id = promotionReceiptId({
        scope: identity, prNumber, headSha: expectedHeadSha,
      });
      const receipt = Object.freeze({
        schemaVersion: 1, id, state: "verified-awaiting-executor",
        scope: identity, prNumber, headSha: expectedHeadSha,
        proof, recordedAt: now(),
      });
      assertRecord(receipt, id);
      const json = JSON.stringify(receipt);
      if (Buffer.byteLength(json) > MAX_RECORD) deny("receipt too large");
      // Stage a fully synced private file first; link atomically to the stable
      // deterministic receipt name. A process crash cannot publish partial JSON.
      // The link is exclusive: concurrent attempts can never overwrite proof.
      const temporary = path.join(root, ".staging-" + randomUUID());
      const handle = await fs.open(temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(json);
        await handle.sync();
      } finally { await handle.close(); }
      let created = false;
      try {
        try {
          await fs.link(temporary, recordPath(root, id));
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        await syncDir(root);
        if (!created) {
          const existing = await readReceipt(root, id);
          return { created: false, receipt: existing };
        }
        return { created: true, receipt };
      } finally {
        await fs.unlink(temporary);
      }
    },
    async read({ scope, prNumber, headSha }) {
      await privateDirectory(root, syncDir);
      const id = promotionReceiptId({ scope, prNumber, headSha });
      try {
        const receipt = await readReceipt(root, id);
        // Return only scoped receipts: file name alone cannot authorize.
        if (IDENTITY_KEYS.some(k => receipt.scope[k] !== scope[k]))
          deny("scope mismatch");
        return receipt;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async listPending(scope) {
      await privateDirectory(root, syncDir);
      const identity = scopeIdentity(scope);
      const entries = await fs.readdir(root);
      if (entries.length > 5000) deny("journal inventory too large");
      const results = [];
      for (const name of entries) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const receipt = await readReceipt(root, name.slice(0, 64));
        if (IDENTITY_KEYS.every(k => receipt.scope[k] === identity[k]))
          results.push(receipt);
      }
      return results.sort((a, b) => a.id.localeCompare(b.id));
    },
  });
}
