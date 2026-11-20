import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { verifiedRecallEnvelope } from "./scoped-recall.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const SAFE_AGENT = /^[a-zA-Z0-9._:-]{1,128}$/;
const KEYS = ["tenantId", "agentId", "repositoryId", "issueId"];
const SQL = `BEGIN READ ONLY;
SELECT coalesce(json_agg(row_to_json(hit)), '[]'::json)::text
FROM (
  SELECT f.name, f.content, f.description, f.updated_at
  FROM memu.recall_files AS f
  WHERE f.user_id = :'scoped_user_id'
    AND f.agent_id = :'scoped_agent_id'
    AND f.track = 'memory'
    AND f.name ~ '^bridge-[0-9a-f]{64}$'
    AND octet_length(f.content) <= 1200
    AND EXISTS (
      SELECT 1 FROM memu.recall_file_segments AS s
      WHERE s.recall_file_id = f.id
        AND s.user_id = :'scoped_user_id'
        AND s.agent_id = :'scoped_agent_id'
        AND s.track = 'memory'
    )
  ORDER BY f.updated_at DESC, f.name
  LIMIT 100
) AS hit;
COMMIT;`;
function fail(message) { throw new Error("Scoped recall unavailable: " + message); }
export function nativeScopedIdentity(scope) {
  if (!scope || KEYS.some(k => typeof scope[k] !== "string" || !scope[k] ||
      scope[k].length > 512 || /[\x00-\x1f\x7f]/.test(scope[k])) ||
      !SAFE_AGENT.test(scope.agentId)) fail("invalid trusted scope");
  const userId = createHash("sha256").update(JSON.stringify([
    scope.tenantId, scope.repositoryId, scope.issueId,
  ])).digest("hex");
  return Object.freeze({ userId, agentId: scope.agentId });
}
export function makeScopedRecallSql() { return SQL; }
export async function readScopedMemuFiles({
  scope, trustedDigests, approvedSources, spawnImpl = spawn,
  now = Date.now(), timeoutMs = 5000,
} = {}) {
  const identity = nativeScopedIdentity(scope);
  if (!(trustedDigests instanceof Set) || trustedDigests.size === 0 ||
      !(approvedSources instanceof Map) || approvedSources.size === 0)
    fail("independent approved source authority missing");
  if (![...trustedDigests].every(d => SHA64.test(d)) ||
      !Number.isFinite(now) || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 10000) fail("invalid trusted recall parameters");
  return new Promise((resolve, reject) => {
    // psql variable substitution is explicitly quoted (:'var') by psql. Do not
    // pass user-derived identifiers as SQL or rely on native CLI unscoped recall.
    const argv = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
      "-v", "scoped_user_id=" + identity.userId,
      "-v", "scoped_agent_id=" + identity.agentId, "-f", "-"];
    let child;
    try {
      child = spawnImpl("/usr/bin/psql", argv, {
        env: { PATH: "/usr/bin:/bin", PGHOST: "/var/run/postgresql",
          PGPORT: "5433", PGDATABASE: "agent_memory" },
        shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { fail("PostgreSQL subprocess unavailable"); }
    let out = "", done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill(); finish(Error("Scoped recall timeout"));
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      out += String(chunk);
      if (Buffer.byteLength(out) > 131072) {
        child.kill(); finish(Error("Scoped recall output exceeds limit"));
      }
    });
    child.stderr.on("data", () => {}); // suppress private DB error details
    child.on("error", () => finish(Error("Scoped recall PostgreSQL failure")));
    child.stdin.on("error", () => finish(Error("Scoped recall SQL input failure")));
    child.on("close", status => {
      if (status !== 0) return finish(Error("Scoped recall PostgreSQL failure"));
      try {
        const rows = JSON.parse(out.trim());
        if (!Array.isArray(rows) || rows.length > 100 ||
            rows.some(row => !row || typeof row !== "object" ||
              typeof row.name !== "string" ||
              !/^bridge-[0-9a-f]{64}$/.test(row.name) ||
              typeof row.content !== "string"))
          fail("invalid result shape");
        const hits = rows.flatMap(row => {
          if (!row || typeof row.name !== "string" ||
              !/^bridge-[0-9a-f]{64}$/.test(row.name) ||
              typeof row.content !== "string") return [];
          const key = row.name.slice(7);
          // These records MUST come from the independently verified control
          // plane, not from mutable DB content or embedded model instructions.
          const approval = approvedSources.get(key);
          if (!approval || approval.content !== row.content ||
              approval.scope?.tenantId !== scope.tenantId ||
              approval.scope?.agentId !== scope.agentId ||
              approval.scope?.repositoryId !== scope.repositoryId ||
              approval.scope?.issueId !== scope.issueId ||
              !HEX40.test(approval.sourceGitSha || "")) return [];
          return [approval];
        });
        finish(null, verifiedRecallEnvelope({ hits }, {
          scope, trustedDigests, now,
        }));
      } catch { finish(Error("Scoped recall invalid authorized response")); }
    });
    child.stdin.end(SQL);
  });
}
