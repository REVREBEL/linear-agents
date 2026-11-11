import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const LINEAR_AGENT_VARS = Object.freeze({
  antigravity: "ANTIGRAVITY_LINEAR_API_KEY",
  trae: "TRAE_LINEAR_API_KEY",
  gemini: "GEMINI_LINEAR_API_KEY",
  gemma: "GEMMA_LINEAR_API_KEY",
  chatgpt: "CHATGPT_LINEAR_API_KEY",
  "chatgpt-cli": "CHATGPT_CLI_LINEAR_API_KEY",
  mock: "MOCK_LINEAR_API_KEY",
});
const locks = new Map();
async function withFileLock(file, fn) {
  const previous = locks.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(file, next);
  try { return await next; }
  finally { if (locks.get(file) === next) locks.delete(file); }
}
async function ignoreLocally(root) {
  const { stdout } = await run("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"]);
  const raw = stdout.trim();
  const exclude = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  let existing = "";
  try { existing = await fs.readFile(exclude, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!existing.split(/\r?\n/).includes("/.env.linear-bridge")) {
    await fs.appendFile(exclude, (existing && !existing.endsWith("\n") ? "\n" : "") + "/.env.linear-bridge\n", { mode: 0o600 });
  }
  const { stdout: tracked } = await run("git", ["-C", root, "ls-files", "--", ".env.linear-bridge"]);
  if (tracked.trim()) throw new Error("Refusing to overwrite tracked .env.linear-bridge");
}
export async function writeLinearEnv(root, agent, token) {
  const name = LINEAR_AGENT_VARS[agent];
  if (!name || typeof token !== "string" || !token) throw new Error("Invalid agent app token");
  const file = path.join(root, ".env.linear-bridge");
  return withFileLock(file, async () => {
    await ignoreLocally(root);
    let original = "";
    try { original = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const lines = original.split(/\r?\n/).filter(line => line && !line.startsWith(name + "="));
    lines.push(name + "=" + JSON.stringify(token));
    const temp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    try {
      await fs.writeFile(temp, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, file);
      await fs.chmod(file, 0o600);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    return file;
  });
}
export async function syncLinearCredential({ agent, repositoryRoot, organizationId, completionUrl, sharedSecret, fetchImpl = fetch, persist = true }) {
  if (!LINEAR_AGENT_VARS[agent] || !sharedSecret || typeof organizationId !== "string" || !organizationId) {
    throw new Error("Missing agent credentials or organization");
  }
  const origin = new URL(completionUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port ||
      origin.pathname !== "/complete" || !origin.hostname.startsWith("linear-")) {
    throw new Error("Unexpected worker completion URL");
  }
  const pinned = process.env["LINEAR_" + agent.toUpperCase().replaceAll("-", "_") + "_WORKER_URL"];
  if (pinned && new URL(pinned).origin !== origin.origin) throw new Error("Worker origin mismatch");
  const response = await fetchImpl(new URL("/bridge/access-token", origin.origin), {
    method: "POST",
    headers: { authorization: "Bearer " + sharedSecret, "content-type": "application/json" },
    body: JSON.stringify({ organizationId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Linear App token fetch failed (HTTP " + response.status + ")");
  const payload = await response.json();
  if (payload?.ok !== true || typeof payload.accessToken !== "string" || !payload.accessToken) {
    throw new Error("Invalid Worker token response");
  }
  if (persist) await writeLinearEnv(repositoryRoot, agent, payload.accessToken);
  return { variable: LINEAR_AGENT_VARS[agent], accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}
