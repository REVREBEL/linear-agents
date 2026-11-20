#!/usr/bin/env node
/**
 * Prepare a *verified, faithfully captured* completed session for memU.
 * memU requires a separate executor between prepare and commit. We do not
 * invent chat messages from an issue summary or mark a task complete here.
 *
 * Usage:
 * node scripts/memu-promote.mjs <session.json> <verification.json>
 *
 * ABR-92 M1: the standalone CLI is deliberately fail-closed. The installed
 * core memu 0.10 does not provide the older `memorize prepare` command. A
 * trusted bridge client and compatible serial host executor must be wired
 * and verified before preparation or a durable memory write is enabled.
 */
import { readFile } from "node:fs/promises";
import { verifyPromotionFromGitHub } from "../memory/promotion-verification.mjs";

export function validatePromotion(session, evidence) {
  if (!session || session.schema_version !== "1.0" ||
      !Array.isArray(session.items) || !session.items.some(x =>
        x?.type === "message" && ["user", "assistant"].includes(x.role) &&
        typeof x.content === "string" && x.content.length > 0)) {
    throw Error("A genuine canonical memU session with at least one message is required");
  }
  if (session.items.some(x => !x || !["message", "tool_call", "tool_result"].includes(x.type)))
    throw Error("Invalid canonical session item");
  if (!evidence || evidence.review?.status !== "approved" ||
      evidence.tests?.status !== "passed" ||
      !/^[0-9a-f]{40}$/.test(evidence.review?.headSha || "") ||
      evidence.review.headSha !== evidence.tests.headSha ||
      typeof evidence.issueId !== "string" || !evidence.issueId) {
    throw Error("Verified review and passing tests for the same PR head are required");
  }
  return { issueId: evidence.issueId, headSha: evidence.review.headSha };
}

export async function prepareMemuPromotion(sessionPath, evidencePath, _binary = "memu", {
  github = null, trustedScope = null, prNumber = null,
  requiredChecks = null, allowedCheckApps = ["github-actions"],
} = {}) {
  // Verify the supplied canonical session shape before any authorization
  // lookup. M1 does not forward these bytes to a memory-writing CLI.
  const sessionBytes = await readFile(sessionPath);
  const session = JSON.parse(sessionBytes.toString("utf8"));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const claimed = validatePromotion(session, evidence);
  // Caller-supplied verification.json is only an untrusted claim. Before any
  // preparation subprocess, fetch fresh GitHub review and CI state through
  // a Bridge-owned authenticated client. The standalone CLI cannot provide
  // this authority and therefore refuses to run unattended.
  const verified = await verifyPromotionFromGitHub({
    github, scope: trustedScope, prNumber,
    expectedHeadSha: claimed.headSha, requiredChecks, allowedCheckApps,
  });
  if (verified.scope.issueId !== claimed.issueId)
    throw Error("Promotion refused: claimed issue does not match trusted job scope");
  // Installed core memu 0.10 has no `memorize prepare` verb. Do not attempt
  // a guessed or unsupported mutation until the host-executor contract is
  // separately validated and explicitly enabled.
  throw Error("memU promotion executor unavailable: core memu CLI lacks memorize prepare");

}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [sessionPath, evidencePath] = process.argv.slice(2);
  if (!sessionPath || !evidencePath) {
    console.error("Usage: node scripts/memu-promote.mjs <canonical-session.json> <verification.json>");
    process.exitCode = 2;
  } else {
    prepareMemuPromotion(sessionPath, evidencePath, process.env.MEMU_BIN || "memu")
      .then(value => process.stdout.write(JSON.stringify(value, null, 2) + "\n"))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
