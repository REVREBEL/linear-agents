import { createHmac, timingSafeEqual, randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildVerifiedMemuPayload } from "./memu-commit-executor.mjs";
import { recallDigest, verifiedRecallEnvelope } from "./scoped-recall.mjs";
import { promotionReceiptId } from "./promotion-journal.mjs";

const SHA = /^[0-9a-f]{64}$/;
const SCOPE = ["tenantId", "agentId", "repositoryId", "issueId"];
const MAX = 8192;
function deny(reason) {
  throw Object.assign(new Error("Approved source refused: " + reason),
    { code: "EAPPROVED_SOURCE_DENIED" });
}
function validScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope) &&
    SCOPE.every(k => typeof scope[k] === "string" && scope[k].length > 0 &&
      scope[k].length <= 512 && !/[\x00-\x1f\x7f]/.test(scope[k]));
}
function validate(source, receipt, now) {
  if (!validScope(source?.scope) || !validScope(receipt?.scope) ||
      SCOPE.some(k => source.scope[k] !== receipt.scope[k]) ||
      receipt.state !== "verified-awaiting-executor" ||
      receipt.proof?.status !== "verified-after-merge" ||
      receipt.proof.headSha !== receipt.headSha ||
      promotionReceiptId(receipt) !== receipt.id ||
      source.sourceGitSha !== receipt.headSha ||
      typeof source.content !== "string" || source.content.length > 600 ||
      !source.content.trim() || typeof source.sourcePath !== "string" ||
      source.sourcePath.length > 256 ||
      !/^[a-zA-Z0-9_./-]+$/.test(source.sourcePath) ||
      source.sourcePath.split("/").some(x => !x || x === "." || x === "..") ||
      !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      typeof source.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(source.expiresAt)) ||
      Date.parse(source.expiresAt) <= now || !SHA.test(recallDigest(source)))
    deny("source scope, provenance or expiry");
}
function hmac(key, payload) {
  return createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
}
function seal(payload, key) {
  return { payload, signature: hmac(key, payload) };
}
function inspect(record, key) {
  if (!record || !record.payload || typeof record.signature !== "string" ||
      !SHA.test(record.signature)) deny("invalid signed source record");
  const expected = hmac(key, record.payload);
  if (!timingSafeEqual(Buffer.from(expected, "hex"),
      Buffer.from(record.signature, "hex"))) deny("signed source integrity");
  return record.payload;
}
async function privateRoot(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
    deny("private approval directory required");
}
async function syncDir(root) {
  const handle = await fs.open(root, fs.constants.O_RDONLY |
    fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRecord(filename) {
  const lst = await fs.lstat(filename);
  if (!lst.isFile() || lst.size > MAX || (lst.mode & 0o077) ||
      (process.getuid && lst.uid !== process.getuid()))
    deny("unsafe approval record");
  const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== lst.ino || stat.dev !== lst.dev ||
        (stat.mode & 0o077) || stat.size > MAX)
      deny("approval record changed");
    const buffer = Buffer.alloc(MAX + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX) deny("approval record too large");
    try { return JSON.parse(buffer.toString("utf8", 0, total)); }
    catch { deny("invalid approval JSON"); }
  } finally { await handle.close(); }
}
/**
 * Key must be independently supplied from private operator custody, not from
 * an agent payload, model result, repository or memU DB. Only a trusted
 * external source verifier can approve a candidate for sealing.
 */
export function createApprovedSourceStore({ root, key, verifySource, journal } = {}) {
  if (!path.isAbsolute(root || "") || !Buffer.isBuffer(key) || key.length < 32 ||
      typeof verifySource !== "function" ||
      typeof journal?.read !== "function" || typeof journal?.readConfirmed !== "function") deny("trusted store dependencies");
  key = Buffer.from(key);
  async function confirmed(receipt, source) {
    const digest = createHash("sha256").update(JSON.stringify(buildVerifiedMemuPayload({receipt,candidate:source}))).digest("hex");
    const persisted = await journal.readConfirmed({scope:source.scope,prNumber:receipt.prNumber,headSha:receipt.headSha,digest});
    if (!isDeepStrictEqual(persisted, receipt)) deny("exact confirmed commit required");
    return digest;
  }
  return Object.freeze({
    async approve({ receipt, source, now = Date.now() }) {
      // Freeze the values we authorize before any asynchronous boundary.
      try { receipt = structuredClone(receipt); source = structuredClone(source); }
      catch { deny("invalid approval inputs"); }
      if (!Number.isFinite(now)) deny("invalid approval time");
      await privateRoot(root);
      validate(source, receipt, now);
      const persisted = await journal.read({
        scope: { ...source.scope }, prNumber: receipt.prNumber, headSha: receipt.headSha,
      });
      if (!isDeepStrictEqual(persisted, receipt))
        deny("independently journaled approval missing");
      if (await verifySource({ scope: { ...source.scope }, sourceGitSha: source.sourceGitSha,
        sourcePath: source.sourcePath, revision: source.revision,
        content: source.content, receiptId: receipt.id }) !== true)
        deny("independent source verification failed");
      if (verifiedRecallEnvelope({ hits: [source] }, {
        scope: source.scope, trustedDigests: new Set([recallDigest(source)]), now,
      }).entries.length !== 1)
        deny("source content failed lower-trust sanitizer");
      const commitDigest = await confirmed(receipt, source);
      const payload = Object.freeze({
        version: 2, receiptId: receipt.id, scope: source.scope,
        receipt, commitDigest,
        sourceGitSha: source.sourceGitSha, sourcePath: source.sourcePath,
        revision: source.revision, expiresAt: source.expiresAt,
        content: source.content, digest: recallDigest(source),
      });
      const encoded = JSON.stringify(seal(payload, key));
      if (Buffer.byteLength(encoded) > MAX) deny("approval too large");
      const temporary = path.join(root, ".staging-" + randomUUID());
      const handle = await fs.open(temporary, fs.constants.O_WRONLY |
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(encoded); await handle.sync(); }
      finally { await handle.close(); }
      let created = false;
      try {
        try { await fs.link(temporary, path.join(root, receipt.id + ".json")); created = true; }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        await syncDir(root);
        const stored = inspect(await readRecord(path.join(root, receipt.id + ".json")), key);
        if (!created && stored.digest !== payload.digest)
          deny("immutable approval conflicts with existing source");
        return Object.freeze({ created, receiptId: receipt.id, digest: stored.digest });
      } finally { await fs.unlink(temporary); }
    },
    async load({ scope, receiptIds, now = Date.now() }) {
      await privateRoot(root);
      if (!Number.isFinite(now) || !validScope(scope) || !Array.isArray(receiptIds) ||
          receiptIds.length > 100 || receiptIds.some(id => !SHA.test(id)))
        deny("invalid requested approval scope");
      const approvedSources = new Map(), trustedDigests = new Set();
      for (const id of new Set(receiptIds)) {
        let record;
        try { record = await readRecord(path.join(root, id + ".json")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const item = inspect(record, key);
        if (item.version !== 2 || item.receiptId !== id ||
            item.scope == null || SCOPE.some(k => item.scope[k] !== scope[k]) ||
            typeof item.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(item.expiresAt)) ||
            Date.parse(item.expiresAt) <= now ||
            !SHA.test(item.digest) || recallDigest(item) !== item.digest)
          deny("unapproved, expired or foreign source record");
        validate(item, item.receipt, now);
        if (await confirmed(item.receipt, item) !== item.commitDigest) deny("commit digest mismatch");
        approvedSources.set(id, item);
        trustedDigests.add(item.digest);
      }
      return Object.freeze({ approvedSources, trustedDigests });
    },
  });
}
