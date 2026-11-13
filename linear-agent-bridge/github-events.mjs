// Compatibility re-exports. Canonical implementation: integrations/github-events.mjs
export { sanitizeGithubEvent, recordGithubEvent, resolveGithubReviewDestination, isSelfAuthoredGithubEvent, classifyGithubReviewEvent, githubReviewChangeKey, shouldDispatchGithubReview, buildGithubReviewPrompt } from "../integrations/github-events.mjs";
