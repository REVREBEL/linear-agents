import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const validRepo = value => REPO.test(value || "") &&
  value.split("/").every(part => part !== "." && part !== "..");
const DELIVERIES = /^[a-zA-Z0-9._:-]{8,160}$/;
const LINEAR_TYPES = new Set(["Linear.AppUserNotification", "Linear.AgentSessionEvent", "Linear.Issue"]);
const CHOICES = new Set(["ignore", "defer", "dispatch", "needs_human_review"]);
const INTENTS = new Set(["initial_pr_review", "revision_review", "implementation_followup",
  "clarification", "ci_failure", "dependency_security", "informational"]);
const sha256 = input => createHash("sha256").update(input).digest("hex");
const validId = value => typeof value === "string" && DELIVERIES.test(value);
const safe = value => typeof value === "string" ? value.slice(0, 120) : "";
const validSha = value => typeof value === "string" && SHA.test(value);
const isRenovate = name => /^renovate(?:\[bot\])?$/i.test(name || "");

function envelope(input) {
  if (!input || typeof input !== "object" || !validId(input.deliveryId) ||
      !["github", "linear"].includes(input.provider) ||
      typeof input.eventType !== "string" || !input.eventType) {
    throw Error("Invalid verified event envelope");
  }
  return Object.freeze({
    schemaVersion: 1, provider: input.provider, deliveryId: input.deliveryId,
    eventType: input.eventType, installationId: input.installationId ?? null,
    organizationId: input.organizationId ?? null, source: input.source ?? null,
    actor: Object.freeze({ id: input.actor?.id ?? null, login: safe(input.actor?.login),
      isBot: input.actor?.isBot === true }),
    target: Object.freeze({
      repository: input.target?.repository ?? null, prNumber: input.target?.prNumber ?? null,
      issueId: input.target?.issueId ?? null, headSha: input.target?.headSha ?? null,
    }),
    hasPromptContext: input.hasPromptContext === true,
    contentHash: input.contentHash ?? null,
    reviewCycle: Number.isSafeInteger(input.reviewCycle) && input.reviewCycle >= 0
      ? input.reviewCycle : 0,
  });
}

/** Input must come from the already authenticated/sanitized GitHub Bridge route. */
export function normalizeVerifiedGithubEvent(event, source) {
  if (!event || !["chatgpt", "antigravity"].includes(source) ||
      !validId(event.delivery) || !["ping", "pull_request", "issue_comment"].includes(event.event)) {
    throw Error("Invalid verified GitHub event");
  }
  if (event.event !== "ping" && (!validRepo(event.repository) ||
      !Number.isSafeInteger(event.number) || event.number < 1)) {
    throw Error("Missing verified GitHub target");
  }
  if (event.headSha && !validSha(event.headSha)) throw Error("Invalid GitHub head SHA");
  return envelope({
    provider: "github", source, deliveryId: event.delivery,
    eventType: event.event + "." + event.action,
    installationId: Number.isSafeInteger(event.installationId) ? event.installationId : null,
    actor: { id: event.actorId ?? null, login: event.actorLogin || event.author || "",
      isBot: event.authorType === "Bot" || /\[bot\]$/i.test(event.actorLogin || event.author || "") },
    target: { repository: event.repository ?? null, prNumber: event.number ?? null,
      headSha: event.headSha ?? null },
    contentHash: event.commentBody ? sha256(event.commentBody) : null,
    hasPromptContext: false,
  });
}

/** Caller must have verified Linear HMAC and OAuth installation before use. */
export function normalizeVerifiedLinearEvent({ deliveryId, eventType, organizationId,
  actorId = null, actorLogin = "", issueId = null, repository = null,
  prNumber = null, headSha = null, hasPromptContext = false } = {}) {
  if (!validId(deliveryId) || !LINEAR_TYPES.has(eventType) ||
      typeof organizationId !== "string" || !organizationId.trim() ||
      organizationId.length > 128 || (issueId !== null && !validId(issueId)) ||
      (repository !== null && !validRepo(repository)) ||
      (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) ||
      (headSha !== null && !validSha(headSha))) throw Error("Invalid verified Linear event");
  return envelope({
    provider: "linear", deliveryId, eventType, organizationId,
    actor: { id: actorId, login: actorLogin }, hasPromptContext,
    target: { issueId, repository, prNumber, headSha },
  });
}

function outcome(decision, intent, reason, priority = "normal") {
  if (!CHOICES.has(decision) || !INTENTS.has(intent)) throw Error("Invalid policy outcome");
  return Object.freeze({ decision, intent, priority, reason,
    requiresVerifiedEnrichment: decision === "defer" || decision === "needs_human_review" });
}

/** Advisory only; does not grant authorization, launch a reviewer or rely on an LLM. */
export function classifyEventIntelligence(event, {
  selfIds = [], selfLogins = [], verifiedSecurityAdvisory = false,
  verifiedCi = "unknown", authorizedReviewRoute = false, alreadyReviewed = false,
} = {}) {
  if (!event || event.schemaVersion !== 1 || !event.target || !event.actor) {
    throw Error("Invalid normalized event");
  }
  const actor = event.actor.login.toLowerCase();
  const own = (event.actor.id !== null && selfIds.some(id => String(id) === String(event.actor.id))) ||
    (actor && selfLogins.some(login => typeof login === "string" &&
      login.toLowerCase() === actor));
  if (own) return outcome("ignore", "informational", "self-authored-event", "low");
  if (event.eventType === "ping.ping" || event.eventType === "pull_request.closed" ||
      event.eventType === "pull_request.converted_to_draft") {
    return outcome("ignore", "informational", "terminal-or-informational-event", "low");
  }
  const renovate = isRenovate(actor);
  if (renovate && !verifiedSecurityAdvisory) {
    return outcome("ignore", "informational", "routine-renovate-no-verified-security-evidence", "low");
  }
  if (renovate && verifiedSecurityAdvisory) {
    return outcome("defer", "dependency_security", "verify-security-patch-and-ci", "high");
  }
  if (event.eventType === "Linear.AppUserNotification") {
    return event.target.issueId || event.target.prNumber
      ? outcome("defer", "clarification", "missing-prompt-enrich-linked-notification")
      : outcome("ignore", "informational", "unroutable-notification-no-target", "low");
  }
  if (event.eventType === "Linear.Issue" || event.eventType === "Linear.AgentSessionEvent") {
    return outcome("defer", "clarification", "resolve-trusted-linear-session-and-state");
  }
  if (event.eventType === "pull_request.opened" ||
      event.eventType === "pull_request.ready_for_review") {
    if (!event.target.headSha) return outcome("defer", "initial_pr_review", "missing-verified-head");
    if (alreadyReviewed) return outcome("ignore", "informational", "review-cycle-already-covered", "low");
    if (verifiedCi === "success" && authorizedReviewRoute) {
      return outcome("dispatch", "initial_pr_review", "verified-review-ready");
    }
    return outcome("defer", "initial_pr_review", "await-verified-ci-and-routing");
  }
  if (event.eventType === "pull_request.synchronize") {
    return outcome("defer", "revision_review", "await-new-head-checks-and-unresolved-findings");
  }
  if (event.eventType === "issue_comment.created" || event.eventType === "issue_comment.edited" ||
      event.eventType.startsWith("pull_request_review")) {
    return outcome("needs_human_review", "implementation_followup",
      "comment-needs-head-and-unresolved-thread-verification");
  }
  return outcome("ignore", "informational", "unsupported-or-routine-event", "low");
}

/** Delivery deduplication and semantic work identity are independent domains. */
export function semanticReviewWorkKey(event, { findingFingerprint = "", reviewCycle = event.reviewCycle } = {}) {
  if (!event || event.schemaVersion !== 1 ||
      !event.target.repository || !validRepo(event.target.repository) ||
      !Number.isSafeInteger(event.target.prNumber) || event.target.prNumber < 1 ||
      !validSha(event.target.headSha) ||
      !(Number.isSafeInteger(event.installationId) && event.installationId > 0 ||
        typeof event.organizationId === "string" && event.organizationId.length > 0) ||
      !Number.isSafeInteger(reviewCycle) || reviewCycle < 0 ||
      typeof findingFingerprint !== "string" || findingFingerprint.length > 256) return null;
  return sha256(JSON.stringify(["abr18-work-v1", event.installationId, event.organizationId,
    event.target.repository, event.target.prNumber, event.target.headSha,
    reviewCycle, findingFingerprint]));
}

/** Shadow-only metadata journal. No model calls, credential access or dispatch. */
export async function recordEventIntelligenceShadow(jobsDir, event, classification) {
  if (!event || event.schemaVersion !== 1 || !validId(event.deliveryId) ||
      !classification || !CHOICES.has(classification.decision) ||
      !INTENTS.has(classification.intent)) throw Error("Invalid shadow record");
  const directory = path.join(jobsDir, "event-intelligence", "shadow");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const key = sha256(JSON.stringify([event.provider, event.organizationId,
    event.installationId, event.deliveryId]));
  const eventHash = sha256(JSON.stringify([event.eventType, event.actor,
    event.target, event.contentHash, event.reviewCycle]));
  const filename = path.join(directory, key + ".json");
  const body = { schemaVersion: 1, recordedAt: new Date().toISOString(),
    provider: event.provider, deliveryHash: key, eventHash,
    eventType: event.eventType,
    target: event.target, actorId: event.actor.id, actorLogin: event.actor.login,
    decision: classification.decision, intent: classification.intent,
    reason: classification.reason, priority: classification.priority,
    contentHash: event.contentHash, semanticWorkKey: semanticReviewWorkKey(event),
    state: "shadow-only", dispatched: false };
  let handle;
  try {
    handle = await fs.open(filename, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await fs.readFile(filename, "utf8"));
    if (previous.deliveryHash !== key || previous.provider !== event.provider ||
        previous.eventType !== event.eventType || previous.eventHash !== eventHash) {
      throw Error("Shadow delivery collision or corrupt receipt");
    }
    return { duplicate: true, path: filename };
  }
  try {
    await handle.writeFile(JSON.stringify(body) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  const dir = await fs.open(directory, "r");
  try { await dir.sync(); } finally { await dir.close(); }
  return { duplicate: false, path: filename };
}
