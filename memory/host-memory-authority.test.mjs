import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createHostMemoryAuthority, loadOperatorSigningKey } from "./host-memory-authority.mjs";
const scope={tenantId:"tenant",agentId:"qwen",repositoryId:"REVREBEL/linear-agents",issueId:"ABR-59"};
const sha="a".repeat(40), merge="b".repeat(40);
const job={jobId:"trusted-123",scope,prNumber:254,headSha:sha};
const policy={requiredChecks:["ci"],allowedCheckApps:["github-actions"],permittedReviewers:["reviewer"]};
const github={
  async getPullRequest(){return {number:254,merged:true,state:"closed",head:{sha,repo:{full_name:scope.repositoryId}},base:{repo:{full_name:scope.repositoryId}},user:{login:"author"},merge_commit_sha:merge};},
  async listReviews(){return [{id:1,user:{login:"reviewer"},state:"APPROVED",commit_id:sha,submitted_at:"2026-11-20T00:00:00Z"}];},
  async listCheckRuns(){return [{id:1,name:"ci",head_sha:sha,app:{slug:"github-actions"},status:"completed",conclusion:"success"}];},
  async getCollaboratorPermission(){return {permission:"write"};}
};
const linear={async getIssue(id){return {id,repositoryId:scope.repositoryId,headSha:sha,status:"completed"};}};
const source={scope,sourceGitSha:sha,sourcePath:"docs/verified-learnings/test.md",revision:1,
  content:"A verified note for isolated memory.",expiresAt:new Date(Date.now()+86400000).toISOString()};
async function key(root, opts={}) {
  const bytes=randomBytes(32), keyId=createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(root,keyId+".key"),bytes,{mode:0o600});
  await fs.writeFile(path.join(root,"active.json"),JSON.stringify({keyId,notBefore:new Date(Date.now()-1000).toISOString(),
    expiresAt:new Date(Date.now()+86400000).toISOString(),revoked:false,...opts}),{mode:0o600});
  return keyId;
}
async function fixture(fn) {
  const root=await fs.mkdtemp(path.join(os.homedir(),".abr59-authority-"));
  try {
    for(const name of ["jobs","journal","approvals"]) await fs.mkdir(path.join(root,name),{mode:0o700});
    await key(root);
    let writes=0;
    const args={root,job,policy,github,linear,verifySource:async()=>true,
      commitImpl:async p=>{writes++;return {recall_files:[{name:p.recall_files[0].name}]};}};
    await fn(args,()=>writes);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
test("confirmed exact payload required before approval and after restart",async()=>fixture(async(args,writes)=>{
  const a=await createHostMemoryAuthority(args);
  const {receipt}=await a.stage();
  await assert.rejects(a.approve(source),/exact confirmed/);
  await assert.rejects(a.commit({...source,scope:{...scope,agentId:"foreign"}}),/authority refused/);
  await a.commit(source);
  assert.equal(writes(),1);
  await assert.rejects(a.approve({...source,sourcePath:"docs/verified-learnings/other.md"}),/digest mismatch/);
  await a.approve(source);
  const b=await createHostMemoryAuthority(args);
  assert.equal((await b.load()).approvedSources.size,1);
  await fs.unlink(path.join(args.root,"journal",receipt.id+".commit-confirmed"));
  await assert.rejects(b.load(),/exact confirmed/);
}));
test("retries cannot change authenticated job identity or pinned review policy",async()=>fixture(async(args)=>{
  await createHostMemoryAuthority(args);
  await assert.rejects(createHostMemoryAuthority({...args,job:{...job,scope:{...scope,agentId:"foreign"}}}),/authority refused/);
  await assert.rejects(createHostMemoryAuthority({...args,policy:{...policy,permittedReviewers:["other"]}}),/authority refused/);
}));
test("rotation invalidates old approval namespace; revoke and expired keys fail closed",async()=>fixture(async(args)=>{
  const a=await createHostMemoryAuthority(args);
  await a.stage();await a.commit(source);await a.approve(source);
  await key(args.root);
  assert.equal((await a.load()).approvedSources.size,0);
  await a.approve(source);
  assert.equal((await a.load()).approvedSources.size,1);
  await key(args.root,{revoked:true});
  await assert.rejects(a.load(),/authority refused/);
  await key(args.root,{expiresAt:new Date(Date.now()-1000).toISOString()});
  await assert.rejects(loadOperatorSigningKey(args.root),/authority refused/);
}));
test("world-accessible key file is rejected",async()=>fixture(async(args)=>{
  const {keyId}=await loadOperatorSigningKey(args.root);
  await fs.chmod(path.join(args.root,keyId+".key"),0o644);
  await assert.rejects(loadOperatorSigningKey(args.root),/authority refused/);
}));
test("tampered confirmed marker or changed current review denies signing",async()=>fixture(async(args)=>{
  const a=await createHostMemoryAuthority(args);
  const {receipt}=await a.stage();
  await a.commit(source);
  const marker=path.join(args.root,"journal",receipt.id+".commit-confirmed");
  const original=await fs.readFile(marker);
  await fs.writeFile(marker,"0".repeat(64));
  await assert.rejects(a.approve(source),/digest mismatch/);
  await fs.writeFile(marker,original);
  const changed={...github,async listReviews(){return [{id:2,user:{login:"reviewer"},state:"APPROVED",commit_id:sha,submitted_at:"2026-11-20T00:00:00Z"}];}};
  const b=await createHostMemoryAuthority({...args,github:changed});
  await assert.rejects(b.approve(source),/authority refused/);
  await a.approve(source);
  assert.equal((await a.load()).approvedSources.size,1);
}));
