import crypto from "node:crypto";

// Remote desktop hooks authenticate with per-job capability tokens.
// The bridge-wide shared secret never leaves Ubuntu for progress reporting.
export function hashRemoteToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
export function validateRemoteTraeActivity(activity, record) {
  if (!record || record.agent !== "trae" || record.executionHost !== "macos" ||
      !record.remoteActivityTokenHash || typeof activity?.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(activity.token)) return false;
  const expected = Buffer.from(record.remoteActivityTokenHash, "hex");
  const actual = Buffer.from(hashRemoteToken(activity.token), "hex");
  if (!crypto.timingSafeEqual(actual, expected)) return false;
  if (activity.jobKey !== record.key ||
      activity.agentSessionId !== record.agentSessionId ||
      activity.workspace !== record.workspace) return false;
  if (!["running", "awaiting_external"].includes(record.state)) return false;
  return Boolean(record.remoteCompletionUrl && /^https:\/\//.test(record.remoteCompletionUrl));
}
export function validateActivityEndpoint(raw, hostname) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== "/trae-activity" ||
      parsed.hostname !== hostname || parsed.port) {
    throw Error("Mac Trae activity endpoint must be the expected HTTPS Trae host");
  }
  return parsed.toString();
}
