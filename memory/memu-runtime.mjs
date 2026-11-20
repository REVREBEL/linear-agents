import fs from "node:fs/promises";
import path from "node:path";

export const MEMU_INSTALLED_BINARY = "/opt/agents/memu/.venv/bin/memu";
export const MEMU_HOST_CONFIG = "/home/bridge/.memu/config.env";
const MAX_BYTES = 8192;
const ALLOWED_KEYS = new Set([
  "MEMU_MEMORY_MODE", "MEMU_DB", "MEMU_EMBED_PROVIDER", "MEMU_EMBED_MODEL",
  "MEMU_BASE_URL", "MEMU_API_KEY", "MEMU_CLIENT_ID",
]);

export function parseMemuConfig(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES ||
      raw.includes("\0")) throw Error("invalid memU config");
  const parsed = Object.create(null);
  for (const original of raw.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !ALLOWED_KEYS.has(match[1]) ||
        Object.hasOwn(parsed, match[1])) throw Error("invalid memU config record");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    // Never eval, source or expand a config file in a shell. Host-owned values
    // are literal; forbid shell interpolation to catch pasted shell commands.
    if (!value || /[\x00-\x1f\x7f`$]/.test(value) || value.length > 2048)
      throw Error("invalid memU config value");
    parsed[match[1]] = value;
  }
  if (parsed.MEMU_MEMORY_MODE !== "local" ||
      parsed.MEMU_EMBED_MODEL !== "nomic-embed-text" ||
      parsed.MEMU_EMBED_PROVIDER !== "openai" ||
      !parsed.MEMU_DB || !parsed.MEMU_BASE_URL)
    throw Error("unsupported local memU provider configuration");
  let url;
  try { url = new URL(parsed.MEMU_BASE_URL); }
  catch { throw Error("invalid local memU endpoint"); }
  if (url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash)
    throw Error("nonlocal memU embedding endpoint");
  return Object.freeze({ ...parsed });
}

/**
 * Private operator-owned file only. The returned environment is for a direct
 * non-shell child process, never for logs, error text, prompt or MCP output.
 */
export async function loadMemuRuntime({
  configPath = MEMU_HOST_CONFIG, binary = MEMU_INSTALLED_BINARY,
  uid = process.getuid?.(),
} = {}) {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(binary) ||
      binary !== MEMU_INSTALLED_BINARY)
    throw Error("memU runtime paths are not approved");
  const file = await fs.lstat(configPath);
  if (!file.isFile() || (file.mode & 0o077) !== 0 ||
      (Number.isInteger(uid) && file.uid !== uid) ||
      file.size <= 0 || file.size > MAX_BYTES)
    throw Error("memU runtime file lacks private ownership or size bounds");
  const handle = await fs.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== file.ino ||
        opened.dev !== file.dev || opened.size > MAX_BYTES ||
        (opened.mode & 0o077) !== 0 ||
        (Number.isInteger(uid) && opened.uid !== uid))
      throw Error("memU runtime file changed or insecure");
    // Bound the actual read even if the owner concurrently grows the file.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) throw Error("memU runtime file too large");
    raw = buffer.toString("utf8", 0, used);
  } finally { await handle.close(); }
  const config = parseMemuConfig(raw);
  // Prefer narrowly scoped variables; don't forward arbitrary bridge secrets.
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/home/bridge",
    LANG: process.env.LANG || "C.UTF-8",
    ...config,
  };
  return Object.freeze({ binary, env: Object.freeze(env),
    diagnostics: Object.freeze({
      cliConfigured: true, configPrivate: true, embedProvider: config.MEMU_EMBED_PROVIDER,
      embedModel: config.MEMU_EMBED_MODEL, localEmbeddingEndpoint: true,
      databaseConfigured: true,
    }) });
}
