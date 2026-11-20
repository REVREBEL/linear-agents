import { spawn } from "node:child_process";
import { loadMemuRuntime, MEMU_INSTALLED_BINARY } from "./memu-runtime.mjs";

const lastWarningAt = new Map();
function warnRecall(reason, logger = console, now = Date.now()) {
  if (now - (lastWarningAt.get(reason) ?? -Infinity) < 60000) return;
  lastWarningAt.set(reason, now);
  logger.warn(`[memU recall] ${reason}; continuing without long-term memory`);
}

// memU CLI 0.10 does not enforce a structured agent/repo/issue search filter.
// Only accept independently attributed matches. Missing metadata fails closed.
const SCOPE_KEYS = ["tenantId", "agentId", "repositoryId", "issueId"];
export function verifiedRecallScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const keys = SCOPE_KEYS;
  if (!keys.every(key => typeof scope[key] === "string" &&
      scope[key].trim().length > 0 && scope[key].length <= 512 &&
      !/[\u0000-\u001f]/.test(scope[key]))) return null;
  return Object.fromEntries(keys.map(key => [key, scope[key]]));
}
function scopedHit(hit, scope) {
  if (!hit || typeof hit !== "object") return false;
  const origin = hit.scope ?? hit.metadata?.scope ?? hit.metadata;
  if (!origin || typeof origin !== "object") return false;
  return Object.entries(scope).every(([key, value]) =>
    Object.hasOwn(origin, key) && origin[key] === value);
}

export function compactRecall(result, limit = 5, scope = null) {
  // memU CLI 0.10+ returns segments/files/resources; older adapters returned hits.
  // Prefer segments to avoid duplicating their parent recall-file content.
  const candidates = Array.isArray(result?.segments) && result.segments.length
    ? result.segments
    : Array.isArray(result?.hits) ? result.hits
    : Array.isArray(result?.files) ? result.files
    : Array.isArray(result?.resources) ? result.resources : [];
  const approved = scope ? candidates.filter(hit => scopedHit(hit, scope)) : candidates;
  const texts = approved.slice(0, Math.max(0, Math.min(limit, 5))).map(hit => {
    if (!hit || typeof hit !== "object") return "";
    const description = typeof hit.description === "string" ? hit.description : "";
    const content = typeof hit.text === "string" ? hit.text
      : typeof hit.content === "string" ? hit.content : "";
    return [description, content].filter(Boolean).join(": ").slice(0, 600);
  }).filter(Boolean);
  return texts.join("\n").slice(0, 2500);
}

/**
 * Fail-open long-term recall. The service is optional during migration and
 * disabled unless explicitly configured. No shell, bounded output and timeout.
 * Never treat retrieved memory as authoritative over the repository.
 */
export async function retrieveMemuMemory(query, {
  enabled = process.env.MEMU_RETRIEVAL_ENABLED === "true",
  binary = process.env.MEMU_BIN || MEMU_INSTALLED_BINARY,
  configPath = process.env.MEMU_RUNTIME_CONFIG_PATH || null,
  runtimeLoader = loadMemuRuntime,
  timeoutMs = 5000,
  scope = null,
  logger = console,
  spawnImpl = spawn,
} = {}) {
  if (!enabled) return "";
  const identity = verifiedRecallScope(scope);
  if (!identity) {
    warnRecall("missing verified tenant/agent/repository/issue scope", logger);
    return "";
  }
  let runtime = { binary, env: process.env };
  if (configPath) {
    try { runtime = await runtimeLoader({ configPath, binary }); }
    catch { warnRecall("runtime configuration unavailable", logger); return ""; }
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(runtime.binary, ["retrieve", String(query).slice(0, 500)], {
        shell: false, env: runtime.env, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { warnRecall("spawn error", logger); resolve(""); return; }
    let out = "", settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); warnRecall("timeout", logger); finish(""); }, timeoutMs);
    child.stdout.on("data", chunk => {
      out += String(chunk);
      if (out.length > 1024 * 1024) { child.kill(); warnRecall("output limit exceeded", logger); finish(""); }
    });
    child.on("error", () => { warnRecall("spawn error", logger); finish(""); });
    child.on("close", code => {
      if (code !== 0) { warnRecall("nonzero exit", logger); return finish(""); }
      try { finish(compactRecall(JSON.parse(out), 5, identity)); }
      catch { warnRecall("invalid response", logger); finish(""); }
    });
  });
}
