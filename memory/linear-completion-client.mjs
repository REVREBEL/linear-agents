const ISSUE = /^(?:[A-Za-z][A-Za-z0-9_-]{0,63}-[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const ENDPOINT = "https://api.linear.app/graphql";
const MAX_BYTES = 256 * 1024;
export const LINEAR_COMPLETION_TIMEOUT_MS = 6000;
const QUERY = `query MemoryCompletion($id:String!,$after:String){issue(id:$id){
  id identifier completedAt archivedAt state{type} team{id}
  attachments(first:100,after:$after){nodes{url} pageInfo{hasNextPage endCursor}}
}}`;
function deny() {
  return Object.assign(new Error("Trusted Linear completion evidence unavailable"),
    { code:"ELINEAR_COMPLETION_DENIED" });
}
function validToken(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 4096 &&
    !/[\x00-\x20\x7f]/.test(value);
}
/**
 * Trusted host-only issue completion reader. The expected PR must be bound
 * independently to the reviewed commit by the GitHub verifier. A Linear
 * attachment proves an issue-to-PR link, NOT an issue-to-commit association.
 */
export function createLinearCompletionClient({
  tokenProvider, teamId, github, repositoryId, prNumber, headSha,
  fetchImpl = fetch, timeoutMs = LINEAR_COMPLETION_TIMEOUT_MS,
} = {}) {
  if (typeof tokenProvider !== "function" || typeof fetchImpl !== "function" ||
      typeof github?.getPullRequest !== "function" ||
      typeof teamId !== "string" || !UUID.test(teamId) ||
      typeof repositoryId !== "string" || !REPO.test(repositoryId) ||
      typeof headSha !== "string" || !SHA.test(headSha) ||
      !Number.isSafeInteger(prNumber) || prNumber < 1 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000)
    throw deny();
  const expectedUrl = "https://github.com/" + repositoryId + "/pull/" + prNumber;
  async function query(id, after) {
    try {
      const token = await tokenProvider();
      if (!validToken(token)) throw deny();
      const response = await fetchImpl(ENDPOINT, {
        method:"POST", redirect:"error",
        headers:{ Authorization:"Bearer " + token, "Content-Type":"application/json" },
        body:JSON.stringify({query:QUERY, variables:{id,after}}),
        signal:AbortSignal.timeout(timeoutMs),
      });
      if (response?.status !== 200 || !response.body?.getReader) throw deny();
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw deny(); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(new TextDecoder("utf-8",{fatal:true})
        .decode(Buffer.concat(chunks,size)));
      if (result.errors?.length || !result.data?.issue) throw deny();
      return result.data.issue;
    } catch { throw deny(); }
  }
  function issueMatches(issue, id) {
    return UUID.test(issue?.id || "") &&
      (issue.id === id || issue.identifier === id) &&
      issue.team?.id === teamId && issue.state?.type === "completed" &&
      issue.archivedAt === null && typeof issue.completedAt === "string" &&
      Number.isFinite(Date.parse(issue.completedAt));
  }
  return Object.freeze({
    async getIssue(id) {
      if (typeof id !== "string" || !ISSUE.test(id)) throw deny();
      try {
        let cursor = null, matched = false, complete = false;
        const seen = new Set();
        let canonicalId;
        for (let page = 0; page < 10; page++) {
          const issue = await query(id,cursor);
          if (!issueMatches(issue,id) || (canonicalId && issue.id !== canonicalId))
            throw deny();
          canonicalId = issue.id;
          const records = issue.attachments;
          if (!Array.isArray(records?.nodes) || records.nodes.length > 100 ||
              typeof records.pageInfo?.hasNextPage !== "boolean") throw deny();
          if (records.nodes.some(node => node?.url === expectedUrl)) matched = true;
          if (!records.pageInfo.hasNextPage) { complete = true; break; }
          const next = records.pageInfo.endCursor;
          if (typeof next !== "string" || !next || next.length > 2048 ||
              seen.has(next) || records.nodes.length === 0) throw deny();
          seen.add(next); cursor = next;
        }
        if (!complete || !matched) throw deny();
        const pr = await github.getPullRequest(repositoryId,prNumber);
        if (pr?.number !== prNumber || pr.merged !== true || pr.state !== "closed" ||
            pr.base?.repo?.full_name !== repositoryId ||
            pr.head?.repo?.full_name !== repositoryId || pr.head?.sha !== headSha)
          throw deny();
        // Recheck completion after GitHub I/O. No issue description, labels,
        // comments, attachment metadata or titles constitute authorization.
        // Re-read the complete attachment connection as well as issue state;
        // a removed PR association must not survive the final check.
        let finalCursor = null, finalMatch = false, finalComplete = false;
        const finalSeen = new Set();
        for (let page = 0; page < 10; page++) {
          const current = await query(id,finalCursor);
          if (!issueMatches(current,id) || current.id !== canonicalId) throw deny();
          const connection = current.attachments;
          if (!Array.isArray(connection?.nodes) || connection.nodes.length > 100 ||
              typeof connection.pageInfo?.hasNextPage !== "boolean") throw deny();
          if (connection.nodes.some(node => node?.url === expectedUrl)) finalMatch = true;
          if (!connection.pageInfo.hasNextPage) { finalComplete = true; break; }
          const next = connection.pageInfo.endCursor;
          if (typeof next !== "string" || !next || next.length > 2048 ||
              finalSeen.has(next) || !connection.nodes.length) throw deny();
          finalSeen.add(next); finalCursor = next;
        }
        if (!finalComplete || !finalMatch) throw deny();
        return Object.freeze({id,statusType:"completed",repositoryId,headSha});
      } catch { throw deny(); }
    },
  });
}
