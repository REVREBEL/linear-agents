import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { nativeScopedIdentity } from "./scoped-postgres-recall.mjs";
import { verifyPromotionFromGitHub } from "./promotion-verification.mjs";
import { promotionReceiptId, promotionJournalRoot } from "./promotion-journal.mjs";

const MAX_TEXT = 600;
const UNSAFE = /(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|password\s*[:=]|api[_-]?key\s*[:=]|-----BEGIN .*PRIVATE KEY|ignore previous instructions|bypass approval|<\/?system>)/i;
function refuse(reason) {
  throw Object.assign(new Error("memU commit denied: " + reason), { code: "EMEMU_COMMIT_DENIED" });
}
export function buildVerifiedMemuPayload({ receipt, candidate }) {
  if (!receipt || receipt.state !== "verified-awaiting-executor" ||
      receipt.proof?.status !== "verified-after-merge" ||
      receipt.proof.headSha !== receipt.headSha ||
      receipt.proof.repository !== receipt.scope?.repositoryId ||
      receipt.proof.prNumber !== receipt.prNumber ||
      promotionReceiptId(receipt) !== receipt.id)
    refuse("unverified receipt");
  const text = candidate?.content;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT ||
      /[\x00-\x1f\x7f]/.test(text) || UNSAFE.test(text))
    refuse("unsafe or oversized learning");
  if (candidate.sourceGitSha !== receipt.headSha ||
      !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 ||
      typeof candidate.sourcePath !== "string" || candidate.sourcePath.length > 256 ||
      !/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9_./-]+$/.test(candidate.sourcePath) ||
      candidate.sourcePath.split("/").some(s => s === "." || s === ".."))
    refuse("unverified learning source");
  // Native memU 0.10 only supports user_id and agent_id; user_id encodes
  // tenant/repo/issue and agent_id isolates the runtime. CLI retrieve is NOT
  // authorized by these fields, so this is NOT a read-side isolation solution.
  const identity = nativeScopedIdentity(receipt.scope);
  return Object.freeze({
    user: { user_id: identity.userId, agent_id: identity.agentId },
    resource: [],
    recall_files: [{
      track: "memory",
      name: "bridge-" + receipt.id,
      description: "Verified task learning " + receipt.scope.issueId + " " + receipt.headSha.slice(0, 12) + " " + candidate.sourcePath + " revision " + candidate.revision,
      content: text,
    }],
  });
}
async function durableClaim(root, id, digest) {
  const name = path.join(root, id + ".commit-started");
  let handle;
  try {
    handle = await fs.open(name, fs.constants.O_CREAT | fs.constants.O_EXCL |
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") refuse("commit already attempted; manual reconciliation required");
    throw error;
  }
  try { await handle.writeFile(digest); await handle.sync(); }
  finally { await handle.close(); }
  const dir = await fs.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
/**
 * Opt-in executor, explicitly injected by trusted orchestration only.
 * The irreversible claim precedes the native memU write. After any crash or
 * uncertain outcome, automatic retry is prohibited (commit may have succeeded).
 */
export async function executeVerifiedMemuCommit({
  journal, journalRoot, github, linear, scope, prNumber, headSha,
  requiredChecks, allowedCheckApps = ["github-actions"], permittedReviewers = null, candidate, commitImpl, verifyCandidate,
} = {}) {
  if (!journal || typeof journal.read !== "function" ||
      !path.isAbsolute(journalRoot || "") || typeof commitImpl !== "function" ||
      !linear || typeof linear.getIssue !== "function" ||
      typeof verifyCandidate !== "function")
    refuse("trusted executor dependencies missing");
  if (promotionJournalRoot(journal) !== path.resolve(journalRoot))
    refuse("journal root mismatch");
  scope = structuredClone(scope);
  candidate = structuredClone(candidate);
  const policy = structuredClone({requiredChecks, allowedCheckApps, permittedReviewers});
  const receipt = await journal.read({ scope, prNumber, headSha });
  if (!receipt) refuse("no durable verified approval receipt");
  if (!isDeepStrictEqual(receipt.policy, policy)) refuse("immutable review policy mismatch");
  const proof = await verifyPromotionFromGitHub({
    github, scope, prNumber, expectedHeadSha: headSha, ...policy,
  });
  if (!isDeepStrictEqual(proof, receipt.proof))
    refuse("current approval differs from journal");
  const issue = await linear.getIssue(scope.issueId);
  if (issue?.id !== scope.issueId ||
      !(issue?.status === "completed" || issue?.statusType === "completed") ||
      issue?.repositoryId !== scope.repositoryId || issue?.headSha !== headSha)
    refuse("independent Linear completion evidence missing");
  const payload = buildVerifiedMemuPayload({ receipt, candidate });
  // The candidate must be derived from independently verified repository
  // evidence, not from model-authored summaries, session prompts, or a claim
  // inside the journal receipt. The trusted source verifier must explicitly
  // bind the candidate to this exact commit and source path.
  const candidateApproved = await verifyCandidate({
    scope: receipt.scope, headSha, sourcePath: candidate.sourcePath,
    revision: candidate.revision, content: candidate.content,
  });
  if (candidateApproved !== true) refuse("candidate source is not independently verified");
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  // Verify private root ownership/permissions without creating any directory.
  const stat = await fs.lstat(journalRoot);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
    refuse("private journal root required");
  await durableClaim(journalRoot, receipt.id, digest);
  let result;
  try {
    result = await commitImpl(payload);
  } catch {
    // Uncertain failure: receipt and claim persist; do not guess that commit
    // rolled back, or retry and risk duplicate/partial side effects.
    refuse("commit result unknown; manual reconciliation required");
  }
  if (!result || !Array.isArray(result.recall_files) ||
      result.recall_files.length !== 1 ||
      result.recall_files[0]?.name !== payload.recall_files[0].name)
    refuse("unconfirmed commit result; manual reconciliation required");
  const receiptPath = path.join(journalRoot, receipt.id + ".commit-confirmed");
  const handle = await fs.open(receiptPath, fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(digest);
    await handle.sync();
  } finally { await handle.close(); }
  const dir = await fs.open(journalRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
  return Object.freeze({ status: "commit-confirmed", id: receipt.id, digest });
}
