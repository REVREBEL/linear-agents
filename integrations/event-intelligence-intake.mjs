import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

/**
 * A signed delivery is immutable; current OAuth issue state and project are
 * not. Snapshot enrichment on first acceptance, but deduplicate/replay-check
 * using only stable signed-event identity and the candidate from that body.
 *
 * A receipt is made visible only via a no-clobber hard link to an already
 * fsynced temporary inode. A crash mid-write leaves no final .json file;
 * a lost ACK leaves a complete receipt that survives an OAuth issue update.
 */
export async function persistNoPromptIntake(jobsDir, value, { files = fs } = {}) {
  const validated = validateNoPromptIntake(value);
  const directory = path.join(jobsDir, "event-intelligence", "linear-intake");
  const deliveryHash = hash(JSON.stringify([
    validated.provider, validated.organizationId, validated.deliveryId,
  ]));
  const receipt = path.join(directory, deliveryHash + ".json");
  const eventHash = hash(JSON.stringify([
    validated.provider, validated.eventType, validated.deliveryId,
    validated.signedPayloadSha256, validated.organizationId,
    validated.workerIdentity, validated.issueId, validated.agentSessionId,
    validated.prCandidate,
  ]));
  // Full snapshot hash is retained for audit only, not for replay comparison.
  const payloadHash = hash(JSON.stringify(validated));
  await files.mkdir(directory, { recursive: true, mode: 0o700 });
  const body = {
    ...validated, deliveryHash, eventHash, payloadHash,
    recordedAt: new Date().toISOString(),
    state: "durable_intake", durable: true, dispatched: false,
    providerFactsVerifiedBy: validated.verifiedIssue ? "linear-oauth-app" : "none",
    githubEvidence: "not_verified",
  };
  const temp = path.join(directory, "." + deliveryHash + "." + randomUUID() + ".tmp");
  let file;
  let created = false;
  try {
    file = await files.open(temp, "wx", 0o600);
    await file.writeFile(JSON.stringify(body) + "\n");
    await file.sync();
    await file.close();
    file = null;
    try {
      // Hard linking is atomic and refuses to replace a competing receipt.
      // The existing destination is never opened for a partial write.
      await files.link(temp, receipt);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (file) await file.close();
    await files.unlink(temp).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  // Fsync the directory after final publication AND temporary cleanup.
  // A competing duplicate ACK also syncs it in case the publisher crashed
  // after link(), before its own directory sync.
  const directoryHandle = await files.open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  if (created) return { duplicate: false, deliveryHash, stage: body.stage };

  let previous;
  try {
    const stat = await files.lstat(receipt);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw Error("Invalid receipt inode or permissions");
    }
    previous = JSON.parse(await files.readFile(receipt, "utf8"));
  } catch {
    throw Error("Intake receipt collision or tampering");
  }
  if (previous.deliveryHash !== deliveryHash || previous.eventHash !== eventHash ||
      previous.signedPayloadSha256 !== validated.signedPayloadSha256 ||
      previous.state !== "durable_intake" || previous.dispatchStatus !== "not_started" ||
      previous.reviewLaunchStatus !== "not_started" || previous.durable !== true ||
      previous.dispatched !== false) {
    throw Error("Intake receipt collision or tampering");
  }
  return { duplicate: true, deliveryHash, stage: previous.stage };
}
