import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeVerifiedLinearEvent, classifyEventIntelligence } from "./event-intelligence.mjs";

const ID = /^[a-zA-Z0-9._:-]{8,160}$/;
const SHA = /^[a-f0-9]{64}$/;
const ISSUE = /^[a-zA-Z0-9_-]{8,128}$/;
const ORG = /^[a-zA-Z0-9_-]{2,128}$/;
const REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const hash = data => createHash("sha256").update(data).digest("hex");
const noPrototype = obj => obj && typeof obj === "object" && !Array.isArray(obj);
const validRepo = value => typeof value === "string" && REPO.test(value) &&
  value.split("/").every(part => part !== "." && part !== "..");

/**
 * The caller is the authenticated reviewer Worker. This validates only
 * typed, bounded, already signed/OAuth-enriched metadata, never arbitrary
 * Linear notification content or proposed agent instructions.
 */
export function validateNoPromptIntake(value) {
  if (!noPrototype(value) || value.schemaVersion !== 2 ||
      value.provider !== "linear" || value.eventType !== "Linear.AppUserNotification" ||
      typeof value.organizationId !== "string" || !ORG.test(value.organizationId) ||
      typeof value.deliveryId !== "string" || !ID.test(value.deliveryId) ||
      typeof value.signedPayloadSha256 !== "string" || !SHA.test(value.signedPayloadSha256) ||
      value.deliveryId !== "event:" + value.signedPayloadSha256 ||
      value.hasPromptContext !== false || value.workerIdentity !== "linear-chatgpt-agent" ||
      (value.issueId !== null && (typeof value.issueId !== "string" || !ISSUE.test(value.issueId))) ||
      (value.agentSessionId !== null && (typeof value.agentSessionId !== "string" ||
        !ISSUE.test(value.agentSessionId))) ||
      (value.prCandidate !== null && (!noPrototype(value.prCandidate) ||
        !validRepo(value.prCandidate.repository) ||
        !Number.isSafeInteger(value.prCandidate.number) || value.prCandidate.number < 1)) ||
      (value.verifiedIssue !== null && (!noPrototype(value.verifiedIssue) ||
        typeof value.issueId !== "string" || value.verifiedIssue.id !== value.issueId ||
        value.verifiedIssue.organizationId !== value.organizationId ||
        typeof value.verifiedIssue.identifier !== "string" ||
        !/^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/.test(value.verifiedIssue.identifier) ||
        (value.verifiedIssue.projectId !== null &&
          (typeof value.verifiedIssue.projectId !== "string" ||
            !ISSUE.test(value.verifiedIssue.projectId))) ||
        !["started", "unstarted", "completed", "canceled", "backlog", "triage"].includes(value.verifiedIssue.stateType)))) {
    throw Error("Invalid signed no-prompt intake");
  }
  if (value.issueId === null && value.verifiedIssue !== null) throw Error("Unlinked verified issue");
  const normalized = normalizeVerifiedLinearEvent({
    deliveryId: value.deliveryId, eventType: value.eventType,
    organizationId: value.organizationId, issueId: value.issueId,
    repository: value.prCandidate?.repository ?? null,
    prNumber: value.prCandidate?.number ?? null,
    hasPromptContext: false,
  });
  const classification = classifyEventIntelligence(normalized);
  const stage = value.verifiedIssue
    ? value.prCandidate ? "awaiting_verified_github_evidence" : "awaiting_verified_pr_link"
    : value.issueId ? "awaiting_verified_linear_issue" : "awaiting_issue_link";
  return Object.freeze({
    schemaVersion: 2, provider: "linear", eventType: value.eventType,
    deliveryId: value.deliveryId, signedPayloadSha256: value.signedPayloadSha256,
    organizationId: value.organizationId, issueId: value.issueId,
    agentSessionId: value.agentSessionId,
    workerIdentity: value.workerIdentity,
    prCandidate: value.prCandidate && Object.freeze({
      repository: value.prCandidate.repository, number: value.prCandidate.number,
    }),
    verifiedIssue: value.verifiedIssue && Object.freeze({
      id: value.verifiedIssue.id,
      identifier: value.verifiedIssue.identifier,
      organizationId: value.verifiedIssue.organizationId,
      projectId: value.verifiedIssue.projectId,
      stateType: value.verifiedIssue.stateType,
    }),
    classification: Object.freeze({
      decision: classification.decision, reason: classification.reason,
      intent: classification.intent,
    }),
    stage, dispatchStatus: "not_started", reviewLaunchStatus: "not_started",
  });
}

/** Persist before acknowledging; duplicate claims never enqueue dispatch. */
export async function persistNoPromptIntake(jobsDir, value) {
  const validated = validateNoPromptIntake(value);
  const directory = path.join(jobsDir, "event-intelligence", "linear-intake");
  const deliveryHash = hash(JSON.stringify([
    validated.provider, validated.organizationId, validated.deliveryId,
  ]));
  const receipt = path.join(directory, deliveryHash + ".json");
  const payloadHash = hash(JSON.stringify(validated));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const body = {
    ...validated, deliveryHash, payloadHash, recordedAt: new Date().toISOString(),
    state: "durable_intake", durable: true, dispatched: false,
    providerFactsVerifiedBy: validated.verifiedIssue ? "linear-oauth-app" : "none",
    githubEvidence: "not_verified",
  };
  let file;
  try { file = await fs.open(receipt, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await fs.readFile(receipt, "utf8"));
    if (previous.deliveryHash !== deliveryHash || previous.payloadHash !== payloadHash ||
        previous.state !== "durable_intake" || previous.dispatchStatus !== "not_started" ||
        previous.durable !== true || previous.dispatched !== false) {
      throw Error("Intake receipt collision or tampering");
    }
    return { duplicate: true, deliveryHash, stage: previous.stage };
  }
  try {
    await file.writeFile(JSON.stringify(body) + "\n");
    await file.sync();
  } finally { await file.close(); }
  const directoryHandle = await fs.open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  return { duplicate: false, deliveryHash, stage: body.stage };
}
