import crypto from "node:crypto";

/**
 * Derive stable per-agent delivery identity from an authenticated Linear
 * request. The displayed job ID is sanitized for filenames; the ledger key
 * preserves the original upstream delivery ID.
 */
export function identifyLinearJobDelivery({ headers, rawBody, agent, now = Date.now, randomUUID = crypto.randomUUID }) {
  const upstreamId = headers["x-linear-webhook-id"];
  const jobId = upstreamId ?? `job-${now()}-${randomUUID()}`;
  const safeJobId = String(jobId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const deliveryId = upstreamId ?? crypto.createHash("sha256").update(rawBody).digest("hex");
  return {
    safeJobId,
    deliveryId,
    jobKey: `${agent}:${String(deliveryId)}`,
  };
}

/**
 * A claimed, failed, interrupted, or unrouted duplicate must not be reported
 * upstream as accepted. Only an already accepted delivery can be ACKed.
 */
export function linearJobDuplicateResponse(claimed, safeJobId, host) {
  if (claimed.created) return null;
  const state = claimed.record?.state || "claimed";
  // A prepared local Trae job is not accepted until its per-job callback
  // capability has been durably recorded. A ledger failure before that point
  // must never be acknowledged as an already-running duplicate.
  const traeWithoutCapability = state === "queued" &&
    claimed.record?.agent === "trae" && !claimed.record?.activityContextFile;
  const managedWithoutAcceptance = claimed.record?.submissionMode === "managed" &&
    !claimed.record?.managedLaunchAcceptedAt;
  if (managedWithoutAcceptance || traeWithoutCapability || ["claimed", "received", "unrouted", "failed", "interrupted"].includes(state)) {
    return {
      status: 503,
      body: {
        ok: false, accepted: false, duplicate: true, state,
        error: "Existing delivery was not accepted; inspect local job ledger before replay",
      },
    };
  }
  return {
    status: 202,
    body: {
      ok: true, accepted: true, duplicate: true,
      jobId: claimed.record?.jobId || safeJobId, state, host,
    },
  };
}
