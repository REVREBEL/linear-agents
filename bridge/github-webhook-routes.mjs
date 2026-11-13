import fs from "node:fs/promises";
import path from "node:path";
import { readBody, sendJson } from "./http-helpers.mjs";
import { sanitizeGithubEvent, recordGithubEvent, shouldDispatchGithubReview,
  classifyGithubReviewEvent, githubReviewChangeKey } from "../integrations/github-events.mjs";

/**
 * GitHub webhook route. The bridge owns the durable inbox and dispatch
 * coordinator; this boundary only relocates its existing request lifecycle.
 * Returns false for any other route, true for handled GitHub webhook requests.
 */
export function createGithubWebhookRoutes({
  sharedSecret: SHARED_SECRET,
  jobsDir: JOBS_DIR,
  linearApiKey: LINEAR_API_KEY,
  selfIdentity: GITHUB_CHATGPT_SELF,
  githubTaskMemory,
  claimGithubReviewDispatch,
  launchGithubShortcutHandoff,
  env = process.env,
  platform = process.platform,
  logger = console,
}) {
  async function handleGithubEvent(request, response) {
      if (request.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
      const source = request.headers["x-github-agent"];
      if (source !== "chatgpt" && source !== "antigravity") {
        return sendJson(response, 400, { ok: false, error: "Unknown GitHub agent" });
      }
      let event;
      try { event = sanitizeGithubEvent(JSON.parse(await readBody(request))); }
      catch (error) { return sendJson(response, 400, { ok: false, error: error.message }); }
      // The review queue is a durable handoff, NOT a completed review
      // or a notification to the ChatGPT user. Legacy Shortcuts stays Mac-only.
      if (platform !== "darwin" &&
          env.CHATGPT_REVIEW_MODE !== "inbox" &&
          shouldDispatchGithubReview(event, source, GITHUB_CHATGPT_SELF)) {
        return sendJson(response, 503, { ok: false, accepted: false,
          reviewDispatched: false, error: "ChatGPT review handoff unavailable on Linux; no delivery or review claim created" });
      }
      if (env.CHATGPT_REVIEW_MODE === "inbox" &&
          shouldDispatchGithubReview(event, source, GITHUB_CHATGPT_SELF) &&
          (!env.CHATGPT_REVIEW_INBOX_TOKEN || env.CHATGPT_REVIEW_INBOX_TOKEN.length < 32)) {
        return sendJson(response, 503, { ok: false, accepted: false,
          error: "Review inbox requires a separate 32+ character CHATGPT_REVIEW_INBOX_TOKEN" });
      }
      if (env.CHATGPT_REVIEW_MODE === "inbox" &&
          env.CHATGPT_REVIEW_NOTIFY_MODE === "linear-user" &&
          shouldDispatchGithubReview(event, source, GITHUB_CHATGPT_SELF) &&
          (!LINEAR_API_KEY || !/^[0-9a-f-]{36}$/i.test(env.CHATGPT_REVIEW_LINEAR_TEAM_ID || "") ||
            !/^[0-9a-f-]{36}$/i.test(env.CHATGPT_REVIEW_LINEAR_USER_ID || ""))) {
        return sendJson(response, 503, { ok: false, accepted: false,
          error: "Review notification requires Linear API key, team UUID and ChatGPT user UUID" });
      }
      const eventDir = path.join(JOBS_DIR, "github-events");
      // Atomic create prevents duplicate webhook retries from being journaled twice.
      await fs.mkdir(eventDir, { recursive: true, mode: 0o700 });
      const claimFile = path.join(eventDir, `${source}-${event.delivery}.claim`);
      try { await fs.writeFile(claimFile, event.delivery, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error.code === "EEXIST") {
          try {
            const recovered = await claimGithubReviewDispatch(event, source);
            if (recovered && !recovered.duplicate) {
              launchGithubShortcutHandoff(recovered);
              return sendJson(response, 202, { ok: true, duplicate: true, recoveredReviewDispatch: true,
                delivery: event.delivery, handoffId: recovered.handoffId, reviewDispatched: !recovered.reviewQueued, reviewQueued: recovered.reviewQueued === true, reviewNotified: recovered.reviewNotified === true, reviewMessageAttempted: recovered.reviewMessageAttempted === true, reviewIssue: recovered.reviewIssue || null });
            }
            return sendJson(response, 202, { ok: true, duplicate: true, delivery: event.delivery,
              reviewDispatched: recovered?.duplicate === true });
          } catch (recoveryError) {
            return sendJson(response, 503, { ok: false, duplicate: true, error: recoveryError.message });
          }
        }
        throw error;
      }
      let handoff;
      try {
        handoff = await claimGithubReviewDispatch(event, source);
        await recordGithubEvent(JOBS_DIR, event, source);
        const classification = classifyGithubReviewEvent(event, GITHUB_CHATGPT_SELF);
        await githubTaskMemory.update(event, {
          lastEvent: event.event + "." + event.action,
          lastDecision: classification.actionable ? "actionable" : "routine",
          lastReason: classification.reason,
          ...(event.headSha ? { lastHeadSha: event.headSha } : {}),
          ...(event.commentId ? { lastCommentId: event.commentId } : {}),
          ...(handoff && !handoff.duplicate ? { lastReviewChange: githubReviewChangeKey(event) } : {}),
        });
        if (handoff && !handoff.duplicate) launchGithubShortcutHandoff(handoff);
        logger.log(`GitHub event recorded: ${source} ${event.event} ${event.action} ${event.repository || ""} ${event.number || ""}`);
        return sendJson(response, 202, { ok: true, accepted: true, delivery: event.delivery,
          ...(handoff && !handoff.duplicate ? { handoffId: handoff.handoffId, reviewDispatched: !handoff.reviewQueued, reviewQueued: handoff.reviewQueued === true, reviewNotified: handoff.reviewNotified === true, reviewMessageAttempted: handoff.reviewMessageAttempted === true, reviewIssue: handoff.reviewIssue || null, reviewId: handoff.reviewId } : { reviewDispatched: handoff?.duplicate === true && env.CHATGPT_REVIEW_MODE !== "inbox", reviewQueued: handoff?.duplicate === true && env.CHATGPT_REVIEW_MODE === "inbox" }) });
      } catch (error) {
        await fs.unlink(claimFile).catch(() => {});
        if (handoff?.dispatchClaim) await fs.unlink(handoff.dispatchClaim).catch(() => {});
        return sendJson(response, 503, { ok: false, error: error.message });
      }
  }

  return async function handleGithubWebhookRoute(request, response, { url }) {
    if (request.method !== "POST" || url.pathname !== "/github/events") return false;
    await handleGithubEvent(request, response);
    return true;
  };
}
