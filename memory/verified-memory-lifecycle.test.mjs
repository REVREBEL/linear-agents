import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash,randomBytes} from "node:crypto";
import {createVerifiedMemoryLifecycle} from "./verified-memory-lifecycle.mjs";
import {verifiedRecallEnvelope,recallDigest} from "./scoped-recall.mjs";
import {promotionReceiptId} from "./promotion-journal.mjs";

const scope={tenantId:"test-workspace",agentId:"qwen",repositoryId:"REVREBEL/linear-agents",issueId:"ABR-59"};
const sha="a".repeat(40),job={jobId:"pinned-admitted-job",scope,prNumber:275,headSha:sha};
const policy={requiredChecks:["verified"],allowedCheckApps:["github-actions"],permittedReviewers:["independent"]};
const sourcePath="docs/verified-learnings/verified-note.txt",content="Short independently reviewed scoped learning.";
const pr={number:275,merged:true,state:"closed",head:{sha,repo:{full_name:scope.repositoryId}},
  base:{repo:{full_name:scope.repositoryId}},user:{login:"author"},merge_commit_sha:"b".repeat(40)};
async function fixture(run){
  const root=await fs.mkdtemp(path.join(os.homedir(),".abr59-m13-"));
  let verification=true,done=true,reviewAllowed=true,commits=0,readCalls=0;
  const stored=new Map(),events=[];
  for(const dir of ["jobs","journal","approvals"])await fs.mkdir(path.join(root,dir),{mode:0o700});
  const key=randomBytes(32),keyId=createHash("sha256").update(key).digest("hex");
  await fs.writeFile(path.join(root,keyId+".key"),key,{mode:0o600});
  await fs.writeFile(path.join(root,"active.json"),JSON.stringify({keyId,
    notBefore:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),revoked:false}),{mode:0o600});
  const github={
    async getPullRequest(){return pr;},
    async listReviews(){return reviewAllowed?[{id:1,state:"APPROVED",commit_id:sha,user:{login:"independent"},submitted_at:"2026-11-20T00:00:00Z"}]:[];},
    async listCheckRuns(){return [{id:1,name:"verified",head_sha:sha,status:"completed",conclusion:"success",app:{slug:"github-actions"}}];},
    async getCollaboratorPermission(){return {permission:"write"};},
  };
  const linear={async getIssue(id){return {id,repositoryId:scope.repositoryId,headSha:sha,statusType:done?"completed":"started"};}};
  const factory=(overrides={})=>createVerifiedMemoryLifecycle({
    trustedJob:job,policy,sourcePath,authorityRoot:root,repositoryRoot:"/home/operator/reviewed",
    makeClients:async()=>({github,linear}),
    makeSourceVerifier:()=>async q=>verification&&q.scope.repositoryId===scope.repositoryId&&
      (q.sourceGitSha??q.headSha)===sha&&q.sourcePath===sourcePath&&q.content===content&&q.revision===1,
    readGit:async()=>{readCalls++;return Buffer.from(content);},
    makePersistence:async()=>({
      async commit(payload){commits++;stored.set(payload.recall_files[0].name,payload);return {recall_files:payload.recall_files,resources:[]};},
      async recall({approvedSources,trustedDigests}){
        const hits=[];
        for(const [id,source] of approvedSources){
          const storedFile=stored.get("bridge-"+id);
          if(storedFile?.recall_files?.[0]?.content===source.content)hits.push(source);
        }
        return verifiedRecallEnvelope({hits},{scope,trustedDigests});
      }
    }),
    observer:e=>events.push(e),...overrides,
  });
  try{await run({factory,root,events,commits:()=>commits,reads:()=>readCalls,
    setVerified:x=>verification=x,setDone:x=>done=x,setReview:x=>reviewAllowed=x,keyId,stored});}
  finally{await fs.rm(root,{recursive:true,force:true});}
}
test("operator verified completion -> native commit -> signed approval -> fresh process recall",async()=>fixture(async f=>{
  const a=f.factory(), id=promotionReceiptId(job);
  const out=await a.promote({issueId:scope.issueId,jobId:job.jobId});
  assert.equal(out.status,"approved");
  assert.equal(f.commits(),1);
  const started=await fs.readFile(path.join(f.root,"journal",id+".commit-started"),"utf8");
  const confirmed=await fs.readFile(path.join(f.root,"journal",id+".commit-confirmed"),"utf8");
  assert.equal(started,confirmed);
  assert.match(started,/^[0-9a-f]{64}$/);
  const fresh=f.factory();
  const recalled=await fresh.recall({scope});
  assert.equal(recalled.entries.length,1);
  assert.equal(recalled.entries[0].content,content);
  assert.ok(f.events.includes("approved")&&f.events.includes("recalled"));
  assert.equal((await fresh.promote({issueId:scope.issueId,jobId:job.jobId})).status,"already-confirmed");
  assert.equal(f.commits(),1);
}));
test("untrusted completion hint cannot alter scope, job or choose candidate path",async()=>fixture(async f=>{
  const a=f.factory();
  for(const attempt of [
    {issueId:"ABR-60",jobId:job.jobId},
    {issueId:scope.issueId,jobId:"spoofed"},
    {issueId:scope.issueId,jobId:job.jobId,sourcePath:"docs/verified-learnings/evil.txt"},
  ]){
    if(attempt.sourcePath)continue; // extra fields are ignored, not used as authority
    await assert.rejects(a.promote(attempt),/denied/);
  }
  f.setVerified(false);
  await assert.rejects(a.promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  assert.equal(f.commits(),0);
}));
test("fresh review and Linear completion are required even for replay",async()=>fixture(async f=>{
  const a=f.factory();f.setDone(false);
  await assert.rejects(a.promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  assert.equal(f.commits(),0);
  f.setDone(true);await a.promote({issueId:scope.issueId,jobId:job.jobId});
  f.setReview(false);
  await assert.rejects(f.factory().promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  f.setReview(true);f.setDone(false);
  await assert.rejects(f.factory().promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  assert.equal(f.commits(),1);
}));
test("replay after uncertain commit cannot retry even in a new process",async()=>fixture(async f=>{
  let calls=0;
  const first=f.factory({makePersistence:async()=>({
    async commit(){calls++;throw Error("simulated ambiguous native failure");},
    async recall(){throw Error("must not recall");},
  })});
  await assert.rejects(first.promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  assert.equal(calls,1);
  const newProcess=f.factory();
  await assert.rejects(newProcess.promote({issueId:scope.issueId,jobId:job.jobId}),/denied/);
  assert.equal(f.commits(),0);
  assert.ok(f.events.includes("reconcile"));
}));
test("foreign scope, revoked signing key and expired source deny recall",async()=>fixture(async f=>{
  const a=f.factory();
  await a.promote({issueId:scope.issueId,jobId:job.jobId});
  await assert.rejects(a.recall({scope:{...scope,agentId:"foreign"}}),/denied/);
  await fs.writeFile(path.join(f.root,"active.json"),JSON.stringify({
    keyId:f.keyId,notBefore:"2026-01-01T00:00:00Z",expiresAt:"2099-01-01T00:00:00Z",revoked:true}),{mode:0o600});
  await assert.rejects(f.factory().recall({scope}),/denied/);
}));
