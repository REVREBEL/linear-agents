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
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now;
}
async function withCheckpointLock(filename, action) {
  // Exclusive file creation is atomic across processes. Do not reap a lock
  // merely because a PID appears dead: PID reuse and slow writes make that unsafe.
  const lockfile = filename + ".lock";
  let handle;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      handle = await fs.open(lockfile, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw Error("Checkpoint lock busy; inspect the existing lock before retrying");
  try { return await action(); }
  finally {
    await handle.close();
    await fs.unlink(lockfile).catch(() => {});
  }
}


// Checkpoints are data, never an authority to run stale or unsafe instructions.
const SENSITIVE_FIELD = /(?:token|secret|password|passwd|credential|authorization|private[_-]?key|api[_-]?key)/i;
const OPERATIONAL_FIELDS = new Set(["lastJobKey", "jobKey", "issueId", "lastSessionId"]);
export function sanitizeCheckpointText(text) {
  return String(text)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:github_pat|gh[pousr]|lin_api|lin_oauth)_[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
export function sanitizeCheckpoint(value, depth = 0) {
  if (depth > 20) throw Error("Checkpoint nesting exceeds limit");
  if (typeof value === "string") return sanitizeCheckpointText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeCheckpoint(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, SENSITIVE_FIELD.test(key) && !OPERATIONAL_FIELDS.has(key)
        ? "[REDACTED]" : sanitizeCheckpoint(entry, depth + 1)]));
  }
  return value;
}
const STATUS_FROM_STATE = { active: "active", pending: "pending",
  "agent-finished": "completed", "needs-recovery": "needs-recovery" };
const STATE_FROM_STATUS = { active: "active", pending: "pending", completed: "agent-finished",
  "needs-recovery": "needs-recovery", failed: "needs-recovery", running: "active" };
export function isCheckpointExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now;
}
async function withCheckpointLock(filename, action) {
  // Exclusive file creation is atomic across processes. Do not reap a lock
  // merely because a PID appears dead: PID reuse and slow writes make that unsafe.
  const lockfile = filename + ".lock";
  let handle;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      handle = await fs.open(lockfile, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw Error("Checkpoint lock busy; inspect the existing lock before retrying");
  try { return await action(); }
  finally {
    await handle.close();
    await fs.unlink(lockfile).catch(() => {});
  }
}

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
      return withCheckpointLock(fileOf(repo, issue), async () => {
        const prior = await read(repo, issue);
        const input = typeof patch === "function" ? patch(prior) : patch;
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw Error("Checkpoint patch must be an object");
        const { expectedRevision, ...fields } = input;
        if (expectedRevision !== undefined && expectedRevision !== (prior?.revision ?? 0)) {
          const err = Error("Checkpoint revision conflict");
          err.code = "ECONFLICT";
          throw err;
        }
        const state = fields.state ?? (fields.status
          ? STATE_FROM_STATUS[fields.status] : null) ?? prior?.state ?? "active";
        const status = fields.status ?? STATUS_FROM_STATE[state];
        if (!STATUS_FROM_STATE[state] || !STATE_FROM_STATUS[status] ||
            STATE_FROM_STATUS[status] !== state) throw Error("Invalid checkpoint lifecycle");
        const next = sanitizeCheckpoint({
          version: 1, schemaVersion: 2, revision: (prior?.revision ?? 0) + 1,
          repositoryRoot: repo, issueId: issue,
          state, status,
          lastJobKey: prior?.lastJobKey || null,
          lastAgent: prior?.lastAgent || null, lastWorkspace: prior?.lastWorkspace || null,
          lastSessionId: prior?.lastSessionId || null, lastSeenAt: prior?.lastSeenAt || null,
          lastVerifiedResult: prior?.lastVerifiedResult || null,
          progress: prior?.progress || [], lastProgressAt: prior?.lastProgressAt || null,
          promotion: prior?.promotion || null,
          expiresAt: prior?.expiresAt || null, nextAction: prior?.nextAction || null,
          artifacts: prior?.artifacts || [], source: prior?.source || null,
          ...fields, repositoryRoot: repo, issueId: issue,
          state, status, updatedAt: new Date().toISOString(),
        });
        const output = fileOf(repo, issue), tmp = output + "." + crypto.randomUUID() + ".tmp";
        try {
          await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await fs.rename(tmp, output);
        } finally { await fs.unlink(tmp).catch(() => {}); }
        return next;
      });
    });

    locks.set(key, job);
    try {
      return await job;
    } finally {
      if (locks.get(key) === job) locks.delete(key);
    }
  }
  async function progress(repo, issue, { kind = "milestone", summary = "", jobKey = null } = {}) {
    if (!repo || !issue || !["milestone", "tool", "checkpoint", "error"].includes(kind)) return null;
    // Only bounded, redacted descriptions; never store raw model transcripts.
    const clean = String(summary).replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/[\r\n]+/g, " ").slice(0, 240);
    const entry = { at: new Date().toISOString(), kind, summary: clean, jobKey };
    return update(repo, issue, prior => ({
      progress: [...(prior?.progress || []), entry].slice(-20),
      lastProgressAt: entry.at,
    }));
  }
  function recoveryPreamble(record) {
    if (!record) return "";
    if (isCheckpointExpired(record)) return [
      "[LinearBridge durable task checkpoint, EXPIRED]",
      "The saved next action is stale. Refresh the Linear issue, Git state, and test evidence before proceeding.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Next action: suppressed (expired checkpoint)",
      "[End LinearBridge checkpoint]",
    ].join("\n");
    return [
      "[LinearBridge durable task checkpoint, non-authoritative]",
      "This is a follow-up for the same issue. Inspect the repository and tests before deciding what remains.",
      "Previous agent: " + (record.lastAgent || "unknown"),
      "Previous state: " + stateDisplay,
      "Previous session: " + (record.lastSessionId || "unknown"),
      "Last recorded result: " + (record.lastVerifiedResult || "not verified"),
      "Next action: " + (record.nextAction || "none"),
      "Expires at: " + (record.expiresAt || "none"),
      ...((record.progress || []).slice(-6).map(item => "Checkpoint: " + item.kind + " - " + item.summary)),
      "Do not recreate existing work without checking it.",
      "[End LinearBridge checkpoint]",
    ].join("\n");
  }
  return { read, update, progress, recoveryPreamble };
}
