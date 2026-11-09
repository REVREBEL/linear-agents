// GitHub is the source of truth for published review delivery.
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const SHA = /^[0-9a-f]{40}$/i;

export async function verifyPublishedGithubReview(record, evidence, {
  token, reviewerLogin, fetchImpl = fetch,
} = {}) {
  const reviewId = evidence?.githubReviewId;
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw Error("Valid GitHub review ID required");
  if (typeof token !== "string" || !token) throw Error("Review verification GitHub token not configured");
  if (!LOGIN.test(reviewerLogin || "")) throw Error("Review verification GitHub login not configured");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
      !Number.isSafeInteger(record.number) || record.number < 1 ||
      !SHA.test(record.headSha || "")) throw Error("Invalid review task GitHub identity");
  const [owner, repo] = record.repository.split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${record.number}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "linearbridge-review-verifier",
  };
  async function read(url) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error(`GitHub verification failed (HTTP ${response.status})`);
    return response.json();
  }
  const [pr, review] = await Promise.all([read(base), read(`${base}/reviews/${reviewId}`)]);
  if (pr.number !== record.number || pr.base?.repo?.full_name?.toLowerCase() !== record.repository.toLowerCase())
    throw Error("GitHub PR does not match review task");
  if (pr.head?.sha?.toLowerCase() !== record.headSha.toLowerCase())
    throw Error("Review task is stale; enqueue a review for the current head");
  if (review.id !== reviewId || !REVIEW_STATES.has(review.state) || !review.submitted_at ||
      review.user?.login?.toLowerCase() !== reviewerLogin.toLowerCase() ||
      review.commit_id?.toLowerCase() !== record.headSha.toLowerCase())
    throw Error("No published review by the configured reviewer for this PR head");
  return {
    githubReviewId: reviewId,
    githubReviewUrl: review.html_url,
    githubReviewState: review.state,
    githubReviewedCommit: review.commit_id,
    githubReviewer: review.user.login,
    verifiedAt: new Date().toISOString(),
  };
}
