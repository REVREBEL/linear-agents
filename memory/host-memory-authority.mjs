import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { verifyPromotionFromGitHub } from "./promotion-verification.mjs";
import { createPromotionJournal, promotionReceiptId } from "./promotion-journal.mjs";
import { executeVerifiedMemuCommit } from "./memu-commit-executor.mjs";
import { createApprovedSourceStore } from "./approved-source-store.mjs";

const fields = ["tenantId","agentId","repositoryId","issueId"];
function deny() { throw Object.assign(new Error("Host memory authority refused"),{code:"EHOST_MEMORY_AUTHORITY"}); }
async function privatePath(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) deny();
  for (let dir = root; ; dir = path.dirname(dir)) {
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || (dir === root ? st.uid !== process.getuid() : ![0,process.getuid()].includes(st.uid)) || (st.mode & (dir === root ? 0o077 : 0o022))) deny();
    if (dir === "/") break;
  }
}
export async function readOperatorFile(root, name, max) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || name==="." || name===".." || !Number.isSafeInteger(max) || max < 1 || max > 65536) deny();
  await privatePath(root);
  const h = await fs.open(path.join(root,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const st = await h.stat();
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > max) deny();
    const buf = Buffer.alloc(max+1);
    let n = 0;
    while(n < buf.length) {
      const {bytesRead} = await h.read(buf,n,buf.length-n,n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if(n > max) deny();
    return buf.subarray(0,n);
  } finally { await h.close(); }
}

/** Operator private, never an agent-supplied root or environment variable.
 * Rotation atomically replaces the active manifest. Older signatures are
 * revoked by design; reapproval requires the exact confirmed receipt. */
export async function loadOperatorSigningKey(root) {
  const raw = await readOperatorFile(root,"active.json",2048);
  const m = JSON.parse(raw.toString("utf8"));
  const now = Date.now();
  if (!/^[0-9a-f]{64}$/.test(m.keyId || "") ||
      !Number.isFinite(Date.parse(m.notBefore)) || !Number.isFinite(Date.parse(m.expiresAt)) ||
      Date.parse(m.notBefore) > now || Date.parse(m.expiresAt) <= now || m.revoked !== false) deny();
  const key = await readOperatorFile(root,m.keyId+".key",32);
  if (key.length !== 32 || createHash("sha256").update(key).digest("hex") !== m.keyId ||
      !(await readOperatorFile(root,"active.json",2048)).equals(raw)) deny();
  return {key,keyId:m.keyId,expiresAt:m.expiresAt};
}

/** Host-only coordinator for ONE authenticated job. The caller is the
 * operator-side admission boundary; do not expose this factory to agents.
 * Fixed dependencies and identity are captured before asynchronous work. */
export async function createHostMemoryAuthority({root,job,policy,github,linear,verifySource,commitImpl} = {}) {
  const fixed = structuredClone(job), rules = structuredClone(policy);
  job = fixed; policy = rules;
  await privatePath(root);
  if (!job || typeof job.jobId !== "string" || !job.jobId ||
      !fields.every(k => typeof job.scope?.[k] === "string" && job.scope[k]) ||
      !Array.isArray(policy?.requiredChecks) || !policy.requiredChecks.length ||
      !Array.isArray(policy?.allowedCheckApps) || !policy.allowedCheckApps.length ||
      !Array.isArray(policy?.permittedReviewers) || !policy.permittedReviewers.length ||
      typeof verifySource !== "function" || typeof commitImpl !== "function") deny();
  if (Object.keys(rules).some(k=>!["requiredChecks","allowedCheckApps","permittedReviewers"].includes(k))) deny();
  const id = promotionReceiptId(fixed);
  const jobRoot = path.join(root,"jobs");
  await privatePath(jobRoot);
  // Bind a stable job ID to one task tuple and policy across fresh processes.
  const jobName = createHash("sha256").update(fixed.jobId).digest("hex")+".json";
  const encoded = Buffer.from(JSON.stringify({job:fixed,policy:rules}));
  const filename = path.join(jobRoot,jobName);
  const temporary=path.join(jobRoot,".staging-"+randomUUID());
  const h=await fs.open(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try {
    try { await h.writeFile(encoded); await h.sync(); } finally { await h.close(); }
    try { await fs.link(temporary,filename); } catch(e){if(e.code!=="EEXIST")throw e;}
    const d = await fs.open(jobRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try { await d.sync(); } finally { await d.close(); }
  } finally {await fs.unlink(temporary);}
  if (!(await readOperatorFile(jobRoot,jobName,16384)).equals(encoded)) deny();
  const journalRoot = path.join(root,"journal");
  const approvalRoot = path.join(root,"approvals");
  await privatePath(journalRoot); await privatePath(approvalRoot);
  const journal = createPromotionJournal({root:journalRoot});
  const scope= fixed.scope, prNumber=fixed.prNumber, headSha=fixed.headSha;
  async function store() {
    const {key,keyId} = await loadOperatorSigningKey(root);
    // Per-key namespace makes rotation a hard invalidation rather than
    // accidentally accepting old seals. Namespace is host private.
    const active = path.join(approvalRoot,keyId);
    try { await fs.mkdir(active,{mode:0o700}); } catch(e) { if(e.code!=="EEXIST") throw e; }
    await privatePath(active);
    return {store:createApprovedSourceStore({root:active,key,verifySource,journal}),keyId};
  }
  return Object.freeze({
    async stage() {
      await loadOperatorSigningKey(root);
      return journal.stageVerified({github,scope,prNumber,expectedHeadSha:headSha,...rules});
    },
    async commit(candidate) {
      await loadOperatorSigningKey(root);
      candidate=structuredClone(candidate);
      if(!fields.every(k=>candidate.scope?.[k]===scope[k])) deny();
      return executeVerifiedMemuCommit({journal,journalRoot,github,linear,scope,prNumber,headSha,...rules,
        candidate,verifyCandidate:verifySource,commitImpl});
    },
    async approve(source) {
      source=structuredClone(source);
      if(!fields.every(k=>source.scope?.[k]===scope[k])) deny();
      if (!Number.isFinite(Date.parse(source.expiresAt)) || Date.parse(source.expiresAt) > Date.now()+30*86400000) deny();
      const receipt=await journal.read({scope,prNumber,headSha});
      if(!receipt) deny();
      const proof=await verifyPromotionFromGitHub({github,scope,prNumber,expectedHeadSha:headSha,...rules});
      if(!isDeepStrictEqual(proof,receipt.proof))deny();
      const issue=await linear.getIssue(scope.issueId);
      if(issue?.id!==scope.issueId||!(issue.statusType==="completed"||issue.status==="completed")||
        issue.repositoryId!==scope.repositoryId||issue.headSha!==headSha)deny();
      const selected=await store();
      const result=await selected.store.approve({receipt,source});
      if((await loadOperatorSigningKey(root)).keyId!==selected.keyId) deny();
      return result;
    },
    async load() {
      const selected=await store();
      const result=await selected.store.load({scope,receiptIds:[id]});
      if((await loadOperatorSigningKey(root)).keyId!==selected.keyId) deny();
      return result;
    }
  });
}
