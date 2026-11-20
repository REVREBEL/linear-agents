import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_TEXT = 600, MAX_RESULTS = 5, MAX_BYTES = 2500;
const SCOPE_KEYS = ["tenantId", "agentId", "repositoryId", "issueId"];
function verifiedRecallScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  if (!SCOPE_KEYS.every(key => typeof scope[key] === "string" &&
      scope[key].trim().length > 0 && scope[key].length <= 512 &&
      !/[\u0000-\u001f]/.test(scope[key]))) return null;
  return Object.fromEntries(SCOPE_KEYS.map(key => [key, scope[key]]));
}
const SECRET = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S+)/i;
const DIRECTIVE = /(?:ignore (?:all |previous |prior )?instructions|system prompt|developer message|you are now|bypass (?:review|security|approval)|run (?:this )?(?:command|shell)|execute (?:command|code)|curl\s+https?:|sudo\s|rm\s+-rf|<\/?(?:system|assistant|developer)>)/i;

function hitBody(hit) {
  return typeof hit?.content === "string" ? hit.content : hit?.text;
}
export function recallDigest(hit) {
  const canonical = JSON.stringify({
    scope: SCOPE_KEYS.map(key => hit?.scope?.[key]),
    sourceGitSha: hit?.sourceGitSha, sourcePath: hit?.sourcePath,
    revision: hit?.revision, expiresAt: hit?.expiresAt,
    content: hitBody(hit),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
function trustRecord(hit, expectedScope, trustedDigests, now) {
  const scope = verifiedRecallScope(hit?.scope);
  if (!scope || !SCOPE_KEYS.every(k => scope[k] === expectedScope[k])) return false;
  if (!SHA.test(hit.sourceGitSha || "") ||
      !Number.isSafeInteger(hit.revision) || hit.revision <= 0 ||
      typeof hit.sourcePath !== "string" || hit.sourcePath.length > 256 ||
      !/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_./-]+$/.test(hit.sourcePath) ||
      typeof hitBody(hit) !== "string" || !hitBody(hit) ||
      hitBody(hit).length > MAX_TEXT || typeof hit.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(hit.expiresAt)) || Date.parse(hit.expiresAt) <= now ||
      SECRET.test(hitBody(hit)) || DIRECTIVE.test(hitBody(hit)) ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/.test(hitBody(hit))) return false;
  const digest = recallDigest(hit);
  // Only a Bridge-verified digest on a *separate trusted control plane* can
  // authorize a record. Self-reported approved metadata is insufficient.
  return trustedDigests instanceof Set && trustedDigests.has(digest);
}
function candidates(result) {
  if (Array.isArray(result?.segments) && result.segments.length) return result.segments;
  if (Array.isArray(result?.hits)) return result.hits;
  if (Array.isArray(result?.files)) return result.files;
  if (Array.isArray(result?.resources)) return result.resources;
  return [];
}
/** Parse only independently digested, exact-scope hits as non-executable data. */
export function verifiedRecallEnvelope(result, {
  scope, trustedDigests, now = Date.now(), limit = MAX_RESULTS,
} = {}) {
  const identity = verifiedRecallScope(scope);
  if (!identity || !(trustedDigests instanceof Set) ||
      trustedDigests.size === 0 || !Number.isFinite(now))
    return Object.freeze({ schemaVersion: 1, trust: "untrusted-reference-only",
      enabled: false, entries: [], text: "" });
  const entries = [], seen = new Set();
  for (const hit of candidates(result).slice(0, 100)) {
    if (entries.length >= Math.max(0, Math.min(limit, MAX_RESULTS))) break;
    if (!trustRecord(hit, identity, trustedDigests, now)) continue;
    const digest = recallDigest(hit);
    if (seen.has(digest)) continue;
    const entry = { content: hitBody(hit), sourcePath: hit.sourcePath,
      sourceGitSha: hit.sourceGitSha, revision: hit.revision,
      expiresAt: hit.expiresAt, digest };
    const candidate = [...entries, entry];
    if (Buffer.byteLength(candidate.map(e => e.content).join("\n")) > MAX_BYTES)
      continue;
    entries.push(Object.freeze(entry)); seen.add(digest);
  }
  return Object.freeze({ schemaVersion: 1, trust: "untrusted-reference-only",
    enabled: true, scope: Object.freeze({ ...identity }),
    entries: Object.freeze(entries), text: entries.map(e => e.content).join("\n") });
}
/** Deterministic search string from trusted route metadata only. */
export function buildScopedRecallQuery({ repositoryId, issueId, taskKind = "coding" } = {}) {
  if (typeof repositoryId !== "string" ||
      !(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repositoryId) ||
        (/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(repositoryId) &&
          !repositoryId.split("/").includes(".."))) ||
      typeof issueId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(issueId) ||
      !["coding", "review", "recovery"].includes(taskKind))
    return null;
  return `Repository ${repositoryId}; issue ${issueId}; ${taskKind} previous decisions, failures, and tests.`;
}
