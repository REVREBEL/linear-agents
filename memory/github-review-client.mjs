const BASE = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 256 * 1024;
function denied() {
  return Object.assign(new Error("Trusted GitHub review client unavailable"),
    { code: "EGITHUB_REVIEW_CLIENT_DENIED" });
}
function safe(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw denied();
  return value;
}
function number(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw denied();
  return value;
}
const ownerRepo = value => {
  const repository = safe(value, REPO);
  const [owner, name] = repository.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") throw denied();
  return owner + "/" + name;
};
function isToken(token) {
  return typeof token === "string" && token.length >= 12 &&
    token.length <= 4096 && !/[\x00-\x20\x7f]/.test(token);
}
/**
 * Trusted host-only REST adapter for the existing promotion-verification
 * contract. TokenProvider is owned by the operator's GitHub App installation
 * credential layer. A prompt, issue, webhook or MCP payload cannot supply it.
 */
export function createGitHubReviewClient({
  tokenProvider, fetchImpl = fetch, timeoutMs = 6000,
} = {}) {
  if (typeof tokenProvider !== "function" || typeof fetchImpl !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000)
    throw denied();
  async function request(apiPath) {
    const token = await tokenProvider();
    if (!isToken(token)) throw denied();
    const url = new URL(apiPath, BASE);
    if (url.origin !== BASE || !url.pathname.startsWith("/repos/") ||
        url.username || url.password || url.hash) throw denied();
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET", redirect: "error",
        headers: { Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "REVREBEL-Agent-Bridge-Memory" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response?.status !== 200 || !response.headers ||
          typeof response.arrayBuffer !== "function") throw denied();
      const len = response.headers.get("content-length");
      if (len !== null && (!/^\d+$/.test(len) || Number(len) > MAX_BYTES))
        throw denied();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw denied();
      const data = JSON.parse(bytes.toString("utf8"));
      return { data, link: response.headers.get("link") || "" };
    } catch { throw denied(); }
  }
  async function collect(repo, suffix, select, limit) {
    const records = [];
    let advertisedTotal = null;
    const pages = Math.ceil(limit / 100);
    for (let page = 1; page <= pages; page++) {
      const result = await request("/repos/" + repo + suffix +
        (suffix.includes("?") ? "&" : "?") + "per_page=100&page=" + page);
      const data = select(result.data);
      if (!Array.isArray(data) || data.length > 100 ||
          records.length + data.length > limit) throw denied();
      records.push(...data);
      if (result.data && !Array.isArray(result.data)) {
        const count = result.data.total_count;
        if (!Number.isSafeInteger(count) || count < 0 || count > limit ||
            (advertisedTotal !== null && advertisedTotal !== count))
          throw denied();
        advertisedTotal = count;
        if (records.length > count) throw denied();
      }
      const hasNext = /<[^>]+>;\s*rel="next"/.test(result.link);
      if (hasNext && page === pages) throw denied();
      if (!hasNext) {
        // An omitted Link header on a full page cannot prove the result is
        // complete. Fetch the next page until a short page or hard limit.
        if (data.length < 100) {
          if (advertisedTotal !== null && records.length !== advertisedTotal)
            throw denied();
          return records;
        }
      } else if (data.length < 100) throw denied();
      if (!hasNext && advertisedTotal !== null &&
          records.length === advertisedTotal) return records;
      if (page === pages) throw denied();
    }
    throw denied();
  }
  return Object.freeze({
    async getPullRequest(repository, prNumber) {
      const repo = ownerRepo(repository);
      const { data } = await request("/repos/" + repo + "/pulls/" + number(prNumber));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw denied();
      return data;
    },
    async listReviews(repository, prNumber) {
      const repo = ownerRepo(repository);
      return collect(repo, "/pulls/" + number(prNumber) + "/reviews",
        data => data, 1000);
    },
    async listCheckRuns(repository, headSha) {
      const repo = ownerRepo(repository);
      const sha = safe(headSha, SHA);
      return collect(repo, "/commits/" + sha + "/check-runs?filter=all",
        data => data?.check_runs, 2000);
    },
    async getCollaboratorPermission(repository, login) {
      const repo = ownerRepo(repository);
      const user = safe(login, LOGIN);
      const { data } = await request("/repos/" + repo + "/collaborators/" +
        user + "/permission");
      if (!data || !["admin", "maintain", "write", "triage", "read", "none"]
        .includes(data.permission)) throw denied();
      return { permission: data.permission };
    },
  });
}
