import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const idOf = (repo, issue) =>
  crypto.createHash("sha256").update(repo + ":" + issue).digest("hex");

/**
 * Operational identifiers and non-secret fields that must never be redacted by key name.
 */
export const OPERATIONAL_ALLOWLIST = new Set([
  "lastJobKey",
  "jobKey",
  "idempotencyKey",
  "issueId",
  "lastSessionId",
  "conversationId",
  "agentSessionId",
  "repositoryRoot",
  "schemaVersion",
  "revision",
  "state",
  "status",
  "lastAgent",
  "lastWorkspace",
  "lastSeenAt",
  "lastVerifiedResult",
  "expiresAt",
  "nextAction",
  "artifacts",
  "source",
  "updatedAt",
  "checkpointId",
  "attempt",
]);

/**
 * Sensitive field name pattern. Matches explicit secret/token/password/credential keys.
 */
export const SENSITIVE_KEY_PATTERN =
  /(?:^|[_\-.])(token|secret|password|passwd|auth|credential|api[_-]?key|private[_-]?key)(?:$|[_\-.])/i;

/**
 * Sanitize high-confidence secrets embedded within free text.
 */
export function sanitizeText(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/Bearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/(?:lin_oauth_|lin_api_)[a-zA-Z0-9_\-]{16,}/g, "[REDACTED_LINEAR_TOKEN]")
    .replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{16,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[a-zA-Z0-9_\-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

/**
 * Recursively sanitize objects and arrays: redacting sensitive field names and sanitizing free text.
 */
export function redact(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = sanitizeText(obj[i]);
      } else if (typeof obj[i] === "object") {
        redact(obj[i]);
      }
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    const isSensitive = !OPERATIONAL_ALLOWLIST.has(k) && SENSITIVE_KEY_PATTERN.test(k);
    if (isSensitive) {
      obj[k] = "[REDACTED]";
    } else if (typeof val === "string") {
      obj[k] = sanitizeText(val);
    } else if (val && typeof val === "object") {
      redact(val);
    }
  }
}

/**
 * Derive lifecycle status consistently from state.
 */
export function deriveStatusFromState(state) {
  switch (state) {
    case "active":
      return "active";
    case "agent-finished":
      return "completed";
    case "needs-recovery":
      return "needs-recovery";
    default:
      return state || "pending";
  }
}

/**
 * Determine whether a checkpoint record has passed its expiration time.
 */
export function isCheckpointExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  const expiry = new Date(record.expiresAt).getTime();
  return !Number.isNaN(expiry) && expiry <= now;
}

/**
 * Durable per-issue checkpoint; intentionally distinct from long-term memU knowledge.
 *
 * Concurrency model:
 * - Single-process writer per host (managed by local bridge LaunchAgent/systemd).
 * - In-memory serialization via Promise queue per checkpoint key.
 * - Cross-process / optimistic CAS validation via `expectedRevision` in patch/options.
 * - Atomic file writes via temporary file and atomic rename.
 */
export function createActiveTaskMemory(root) {
  const dir = path.join(root, "active-task-memory");
  const locks = new Map();
  const fileOf = (repo, issue) => path.join(dir, idOf(repo, issue) + ".json");

  async function read(repo, issue) {
    if (!repo || !issue) return null;
    try {
      const data = JSON.parse(await fs.readFile(fileOf(repo, issue), "utf8"));
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function update(repo, issue, patch, options = {}) {
    if (!repo || !issue) return null;
    const key = idOf(repo, issue);
    const pending = locks.get(key) || Promise.resolve();
    const job = pending.catch(() => {}).then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const prior = await read(repo, issue);

      // CAS: validate expectedRevision if requested
      const expectedRevision = options.expectedRevision ?? patch?.expectedRevision;
      if (expectedRevision !== undefined) {
        const currentRevision = prior?.revision ?? 0;
        if (currentRevision !== expectedRevision) {
          const conflictErr = new Error(
            `Revision conflict for ${repo}:${issue}: expected revision ${expectedRevision}, but found ${currentRevision}`
          );
          conflictErr.code = "ECONFLICT";
          conflictErr.expectedRevision = expectedRevision;
          conflictErr.currentRevision = currentRevision;
          throw conflictErr;
        }
      }

      // Determine state and lifecycle status consistently
      const state = patch?.state || prior?.state || "active";
      const status =
        patch?.status ||
        (patch?.state
          ? deriveStatusFromState(patch.state)
          : prior?.status || deriveStatusFromState(prior?.state || "active"));

      // Clean patch of internal options
      const patchData = { ...patch };
      delete patchData.expectedRevision;

      // Build base checkpoint
      const nextBase = {
        schemaVersion: 2,
        revision: (prior?.revision ?? 0) + 1,
        repositoryRoot: repo,
        issueId: issue,
        state,
        status,
        lastJobKey: prior?.lastJobKey || null,
        lastAgent: prior?.lastAgent || null,
        lastWorkspace: prior?.lastWorkspace || null,
        lastSessionId: prior?.lastSessionId || null,
        lastSeenAt: prior?.lastSeenAt || null,
        lastVerifiedResult: prior?.lastVerifiedResult || null,
        expiresAt: prior?.expiresAt || null,
        nextAction: prior?.nextAction || null,
        artifacts: prior?.artifacts || [],
        source: prior?.source || null,
        ...patchData,
        updatedAt: new Date().toISOString(),
      };

      // Clone and sanitize/redact
      const next = JSON.parse(JSON.stringify(nextBase));
      redact(next);

      const output = fileOf(repo, issue);
      const tmp = output + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(tmp, output);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      return next;
    });

    locks.set(key, job);
    try {
      return await job;
    } finally {
      if (locks.get(key) === job) locks.delete(key);
    }
  }

  function recoveryPreamble(record, options = {}) {
    if (!record) return "";
    const now = options.now ?? Date.now();
    const expired = isCheckpointExpired(record, now);
    const nextActionDisplay = expired
      ? `none (previous action expired at ${record.expiresAt}; do not execute stale next action: ${record.nextAction || "none"})`
      : record.nextAction || "none";
    const stateDisplay = expired
      ? `expired (${record.state || "unknown"})`
      : record.state || "unknown";
    const expiresDisplay = record.expiresAt
      ? `${record.expiresAt}${expired ? " [EXPIRED - STALE]" : ""}`
      : "none";

    return [
      "[LinearBridge durable task checkpoint, non-authoritative]",
      "This is a follow-up for the same issue. Inspect the repository and tests before deciding what remains.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Previous state: " + stateDisplay,
      "Previous session: " + (record.lastSessionId || "unknown"),
      "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
      "Next action: " + nextActionDisplay,
      "Expires at: " + expiresDisplay,
      "Do not recreate existing work without checking it.",
      "[End LinearBridge checkpoint]",
    ].join("\n");
  }

  return { read, update, recoveryPreamble };
}
