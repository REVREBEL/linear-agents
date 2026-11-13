import { readBody, sendJson } from "./http-helpers.mjs";

/**
 * A dedicated handler for the human ChatGPT review inbox. All non-review
 * requests fall through to the existing main bridge router.
 */
export function createReviewRoutes({ reviewInbox, verifyPublishedGithubReview, safeTokenEqual, env = process.env }) {
  async function handleReview(request, response, url) {
      if (env.CHATGPT_REVIEW_MODE !== "inbox") {
        return sendJson(response, 404, { ok: false, error: "Review inbox disabled" });
      }
      const expected = env.CHATGPT_REVIEW_INBOX_TOKEN || "";
      const supplied = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7) : "";
      if (expected.length < 32 || !safeTokenEqual(supplied, expected)) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized review consumer" });
      }
      if (request.method === "GET" && url.pathname === "/reviews/pending") {
        return sendJson(response, 200, { ok: true,
          reviews: await reviewInbox.list({ limit: 20 }) });
      }
      if (request.method === "POST" && url.pathname === "/reviews/claim") {
        const body = JSON.parse(await readBody(request));
        const record = await reviewInbox.claim(body.reviewId, body.reviewer);
        return sendJson(response, record ? 200 : 404, { ok: Boolean(record), record });
      }
      if (request.method === "POST" && url.pathname === "/reviews/complete") {
        const body = JSON.parse(await readBody(request));
        const existing = await reviewInbox.get(body.reviewId);
        if (!existing) return sendJson(response, 404, { ok: false, error: "Review task not found" });
        let delivery = null;
        if (body.status === "reviewed") {
          // Only a published GitHub review by the configured identity counts.
          if (existing.state !== "claimed") {
            return sendJson(response, 409, { ok: false, error: "Review must be claimed first" });
          }
          try {
            delivery = await verifyPublishedGithubReview(existing, body, {
              token: env.CHATGPT_REVIEW_GITHUB_TOKEN,
              reviewerLogin: env.CHATGPT_REVIEW_GITHUB_LOGIN,
            });
          } catch (error) {
            return sendJson(response, 409, { ok: false, error: error.message });
          }
        }
        const record = await reviewInbox.finish(body.reviewId, { ...body, delivery });
        return sendJson(response, record ? 200 : 404, { ok: Boolean(record), record });
      }
      return sendJson(response, 405, { ok: false, error: "Unsupported review operation" });
    
  }

  return async function handleReviewRoute(request, response, { url }) {
    if (!url.pathname.startsWith("/reviews/")) return false;
    await handleReview(request, response, url);
    return true;
  };
}
