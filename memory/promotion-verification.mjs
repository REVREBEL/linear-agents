// ABR-92 M1: independently verify the *current* GitHub review and CI state.
// This is an authorization prerequisite, not a memory write or PR reviewer.
// Callers inject the trusted GitHub App client; no model/MCP-provided status is used.
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PRIVILEGED = new Set(["admin", "maintain", "write"]);

function requireCondition(condition, reason) {
  if (!condition) throw Object.assign(new Error("Promotion refused: " + reason), { code: "EPROMOTION_DENIED" });
}

function verifiedScope(scope) {
  const keys = ["tenantId", "agentId", "repositoryId", "issueId"];
  requireCondition(scope && typeof scope === "object" && !Array.isArray(scope) &&
    keys.every(key => typeof scope[key] === "string" && scope[key].length > 0 &&
      scope[key].length <= 512 && !/[\u0000-\u001f\u007f]/.test(scope[key])),
  "incomplete trusted job scope");
  requireCondition(REPO.test(scope.repositoryId) && IDENTIFIER.test(scope.issueId),
    "invalid repository or issue identity");
  return Object.fromEntries(keys.map(key => [key, scope[key]]));
}

function latestReviewsByUser(reviews) {
  requireCondition(Array.isArray(reviews) && reviews.length <= 1000 &&
    reviews.every(r => r && typeof r === "object" &&
      typeof r.user?.login === "string" &&
      Number.isSafeInteger(r.id) && typeof r.state === "string" &&
      typeof r.submitted_at === "string"), "invalid GitHub review response");
  const latest = new Map();
  // GitHub returns reviews in submission order; reviewer decisions are
  // superseded by subsequent states, including dismissal and changes request.
  for (const r of [...reviews].sort((a, b) =>
    Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id)) {
    requireCondition(Number.isFinite(Date.parse(r.submitted_at)), "invalid review timestamp");
    latest.set(r.user.login.toLowerCase(), r);
  }
  return latest;
}

export async function verifyPromotionFromGitHub({
  scope, prNumber, expectedHeadSha, requiredChecks, allowedCheckApps = ["github-actions"],
  github, permittedReviewers = null,
} = {}) {
  const identity = verifiedScope(scope);
  requireCondition(Number.isSafeInteger(prNumber) && prNumber > 0 &&
    SHA.test(expectedHeadSha || ""), "invalid PR or expected full SHA");
  requireCondition(Array.isArray(requiredChecks) && requiredChecks.length > 0 &&
    requiredChecks.length <= 30 &&
    requiredChecks.every(x => typeof x === "string" && x.trim() && x.length <= 160) &&
    new Set(requiredChecks).size === requiredChecks.length, "explicit required checks missing");
  requireCondition(Array.isArray(allowedCheckApps) && allowedCheckApps.length > 0 &&
    allowedCheckApps.every(x => typeof x === "string" && x.length > 0),
    "trusted CI app allowlist missing");
  requireCondition(github && ["getPullRequest", "listReviews", "listCheckRuns", "getCollaboratorPermission"]
    .every(name => typeof github[name] === "function"), "trusted GitHub client missing");
  if (permittedReviewers !== null) requireCondition(Array.isArray(permittedReviewers) &&
    permittedReviewers.length > 0, "invalid reviewer allowlist");

  // Read all facts directly from the trusted GitHub App, not caller-provided
  // approval/test objects. Client methods must return complete, untruncated
  // result sets and throw on pagination/error.
  const repository = identity.repositoryId;
  const pr = await github.getPullRequest(repository, prNumber);
  requireCondition(pr?.number === prNumber && pr?.base?.repo?.full_name === repository &&
    pr?.head?.repo?.full_name === repository && pr?.head?.sha === expectedHeadSha &&
    pr?.state === "closed" && pr?.merged === true &&
    typeof pr?.user?.login === "string" &&
    pr?.merge_commit_sha && SHA.test(pr.merge_commit_sha), "PR is not merged or changed head/repository");
  // Verify the merge references the same approved head; reject stale or
  // unrelated published revisions even if their state is otherwise healthy.
  const [reviews, checks] = await Promise.all([
    github.listReviews(repository, prNumber),
    github.listCheckRuns(repository, expectedHeadSha),
  ]);
  const latest = latestReviewsByUser(reviews);
  let approval = null;
  for (const [login, review] of latest) {
    if (login === pr.user.login.toLowerCase() ||
        review.state.toUpperCase() !== "APPROVED" ||
        review.commit_id !== expectedHeadSha) continue;
    if (permittedReviewers && !permittedReviewers.some(x => x.toLowerCase() === login)) continue;
    const permission = await github.getCollaboratorPermission(repository, login);
    if (!PRIVILEGED.has(permission?.permission)) continue;
    approval = { reviewer: login, reviewId: review.id, submittedAt: review.submitted_at };
    break;
  }
  requireCondition(approval, "no current authorized same-SHA approval");
  requireCondition(Array.isArray(checks) && checks.length <= 2000, "invalid or incomplete CI checks");
  const passedChecks = [];
  for (const name of requiredChecks) {
    const matches = checks.filter(check => check?.name === name &&
      check?.head_sha === expectedHeadSha &&
      allowedCheckApps.includes(check?.app?.slug));
    requireCondition(matches.length > 0, "required trusted CI check missing: " + name);
    // GitHub check-run IDs increase with new runs. Use the most recent ID,
    // not completion time: an older successful run can finish after a rerun
    // has begun, and must not mask the newer in-progress or failed check.
    requireCondition(matches.every(run => Number.isSafeInteger(run.id) && run.id > 0),
      "invalid CI run identity");
    matches.sort((a, b) => b.id - a.id);
    const current = matches[0];
    requireCondition(current.status === "completed" && current.conclusion === "success" &&
      Number.isSafeInteger(current.id), "required CI check not passing: " + name);
    passedChecks.push({ name, checkRunId: current.id, app: current.app.slug });
  }
  // Re-check head after potentially slow pagination/API calls.
  const currentPr = await github.getPullRequest(repository, prNumber);
  requireCondition(currentPr?.head?.sha === expectedHeadSha &&
    currentPr?.state === "closed" && currentPr.merged === true,
    "PR head changed during verification");

  return Object.freeze({
    schemaVersion: 1,
    scope: identity, repository, prNumber, headSha: expectedHeadSha,
    mergeCommitSha: pr.merge_commit_sha, approval, checks: passedChecks,
    status: "verified-after-merge",
  });
}
