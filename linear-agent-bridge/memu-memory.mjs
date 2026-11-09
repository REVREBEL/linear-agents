import { spawn } from "node:child_process";

const lastWarningAt = new Map();
function warnRecall(reason, logger = console, now = Date.now()) {
  if (now - (lastWarningAt.get(reason) ?? -Infinity) < 60000) return;
  lastWarningAt.set(reason, now);
  logger.warn(`[memU recall] ${reason}; continuing without long-term memory`);
}

export function compactRecall(result, limit = 5) {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const texts = hits.slice(0, limit).map(hit =>
    [hit.description, hit.text || hit.content]
      .filter(value => typeof value === "string" && value.length > 0)
      .join(": ").slice(0, 600)
  ).filter(Boolean);
  return texts.join("\n").slice(0, 2500);
}

/**
 * Fail-open long-term recall. The service is optional during migration and
 * disabled unless explicitly configured. No shell, bounded output and timeout.
 * Never treat retrieved memory as authoritative over the repository.
 */
export async function retrieveMemuMemory(query, {
  enabled = process.env.MEMU_RETRIEVAL_ENABLED === "true",
  binary = process.env.MEMU_BIN || "memu",
  timeoutMs = 5000,
  logger = console,
  spawnImpl = spawn,
} = {}) {
  if (!enabled) return "";
  return new Promise(resolve => {
    const child = spawnImpl(binary, ["retrieve", String(query).slice(0, 500)], {
      shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
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
      try { finish(compactRecall(JSON.parse(out))); }
      catch { warnRecall("invalid response", logger); finish(""); }
    });
  });
}
