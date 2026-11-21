import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const gitExec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE = /^docs\/verified-learnings\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt)$/;
const MAX_CONTENT = 600;
const MAX_STDOUT = 4096;
const TIMEOUT = 5000;
function denied() {
  return Object.assign(new Error("Trusted Git source verification unavailable"),
    { code: "EGIT_SOURCE_UNVERIFIED" });
}
function normalizeRemote(remote) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/.exec(remote);
  return m?.[1] ?? null;
}
function sourceArguments(value) {
  try {
    // Take primitive snapshots before the first asynchronous boundary. No
    // model-owned object is used after verification begins.
    const scope = value?.scope;
    const repositoryId = scope?.repositoryId;
    const headSha = value?.headSha ?? value?.sourceGitSha;
    const sourceGitSha = value?.sourceGitSha ?? value?.headSha;
    const sourcePath = value?.sourcePath;
    const revision = value?.revision;
    const content = value?.content;
    const receiptId = value?.receiptId;
    if (!REPO.test(repositoryId || "") ||
        !SHA.test(headSha || "") || sourceGitSha !== headSha ||
        !SOURCE.test(sourcePath || "") ||
        !Number.isSafeInteger(revision) || revision !== 1 ||
        typeof content !== "string" || !content || content.length > MAX_CONTENT ||
        Buffer.byteLength(content, "utf8") > MAX_CONTENT ||
        content.includes("\0") || content.includes("\r") ||
        (receiptId !== undefined && !DIGEST.test(receiptId)))
      throw denied();
    return { repositoryId, headSha, sourcePath, content };
  } catch { throw denied(); }
}
function trustedRoots(repositories) {
  if (!repositories || typeof repositories !== "object" ||
      Array.isArray(repositories) || !Object.keys(repositories).length)
    throw denied();
  const rootMap = new Map();
  for (const [repositoryId, root] of Object.entries(repositories)) {
    if (!REPO.test(repositoryId) || typeof root !== "string" ||
        !path.isAbsolute(root) || path.normalize(root) !== root)
      throw denied();
    rootMap.set(repositoryId, root);
  }
  return rootMap;
}
/**
 * Host-only Git object attestation. The trusted operator supplies the
 * repository/root mapping; no source path, remote URL or checkout directory
 * comes from a model, issue body, MCP response or env variable.
 *
 * Learning source contract: a single short, tracked, non-symlink regular file
 * under docs/verified-learnings at the reviewed full commit SHA. Version 1
 * means entire-file exact content, never a paraphrase or fuzzy excerpt.
 */
export function createTrustedGitSourceVerifier({
  repositories, execImpl = gitExec,
} = {}) {
  const roots = trustedRoots(repositories);
  if (typeof execImpl !== "function") throw denied();
  return async function verifyCommittedSource(input) {
    let request;
    try { request = sourceArguments(input); }
    catch { return false; }
    const root = roots.get(request.repositoryId);
    if (!root) return false;
    const cmd = async (...args) => {
      try {
        const { stdout } = await execImpl("/usr/bin/git",
          ["--no-pager", ...args], {
            cwd: root, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent",
              GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
            maxBuffer: MAX_STDOUT, timeout: TIMEOUT,
            encoding: "utf8", windowsHide: true,
          });
        return stdout;
      } catch { throw denied(); }
    };
    try {
      // Ensure this checkout still matches the operator-bound repository.
      const actual = await fs.realpath(root);
      if (actual !== root) return false;
      if ((await cmd("rev-parse", "--show-toplevel")).trim() !== root)
        return false;
      const remote = await cmd("remote", "get-url", "origin");
      if (normalizeRemote(remote) !== request.repositoryId) return false;
      if ((await cmd("cat-file", "-t", request.headSha)).trim() !== "commit")
        return false;
      const mode = await cmd("ls-tree", request.headSha, "--", request.sourcePath);
      if (!/^100644 blob [0-9a-f]{40}\t/.test(mode) ||
          mode.trim().split("\n").length !== 1) return false;
      const blob = await cmd("show", request.headSha + ":" + request.sourcePath);
      // Full byte-for-byte correspondence is deliberately required. A Git
      // change at the same path cannot be substituted at a different SHA.
      return blob === request.content;
    } catch { return false; }
  };
}
