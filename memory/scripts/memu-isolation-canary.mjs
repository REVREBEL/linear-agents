#!/usr/bin/env node
// Host-only disposable integration canary. No production database credentials
// are passed to subprocesses. GitHub and Linear responses are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPromotionJournal, promotionReceiptId } from "../promotion-journal.mjs";
import { executeVerifiedMemuCommit } from "../memu-commit-executor.mjs";
import { createApprovedSourceStore } from "../approved-source-store.mjs";
import { createTrustedGitSourceVerifier } from "../trusted-git-source.mjs";
import { readScopedMemuFiles, nativeScopedIdentity, makeScopedRecallSql } from "../scoped-postgres-recall.mjs";
import { loadMemuRuntime } from "../memu-runtime.mjs";

const [root, mode] = process.argv.slice(2);
assert.match(root || "", /^\/var\/tmp\/abr59-isolated\.[A-Za-z0-9]{8}$/);
assert.ok(mode === undefined || mode === "--resume");
assert.equal(await fs.realpath(root), root);
const stat = await fs.lstat(root);
assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
assert.equal(process.env.PGHOST, path.join(root, "socket"));
assert.equal(process.env.PGPORT, "55439");
assert.equal(process.env.PGUSER, "bridge");
assert.equal(process.env.PGDATABASE, "abr59_canary");
const socket = await fs.lstat(path.join(root, "socket", ".s.PGSQL.55439"));
assert.ok(socket.isSocket() && socket.uid === process.getuid());
const pg = "/usr/lib/postgresql/18/bin/psql";
const env = { PATH:"/usr/bin:/bin", PGHOST:process.env.PGHOST,
  PGPORT:"55439", PGUSER:"bridge", PGDATABASE:"abr59_canary" };
function sql(query) {
  return execFileSync(pg, ["-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-c",query],
    {env,encoding:"utf8",timeout:10000,maxBuffer:65536}).trim();
}
assert.equal(sql("SELECT current_database(), current_user, inet_server_addr() IS NULL"),
  "abr59_canary|bridge|t");
assert.equal(sql("SHOW data_directory"),path.join(root,"data"));
const journalRoot=path.join(root,"receipts");
const approvalRoot=path.join(root,"approvals");
const repoRoot=path.join(root,"repo");
const repo="Canary/memory-isolation";
const prNumber=1, requiredChecks=["synthetic-canary"];
const baseScope={tenantId:"tenant-a",agentId:"agent-a",repositoryId:repo,issueId:"CAN-1"};
// Change one scope field at a time. Every variant has a distinct memory.
const scopes=[baseScope,{...baseScope,tenantId:"tenant-b"},
  {...baseScope,agentId:"agent-b"},{...baseScope,repositoryId:"Canary/second-repo"},
  {...baseScope,issueId:"CAN-2"}];
const notes=["The amber retrieval check verifies a scoped memory.",
  "The cobalt retrieval check verifies tenant separation.",
  "The emerald retrieval check verifies agent separation.",
  "The violet retrieval check verifies repository separation.",
  "The silver retrieval check verifies issue separation."];
const expiresAt="2099-01-01T00:00:00Z";
const roots={};
const gitEnv={PATH:"/usr/bin:/bin",HOME:path.join(root,"home"),
  GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};
function git(dir,...args) {
  return execFileSync("/usr/bin/git",args,{cwd:dir,env:gitEnv,
    encoding:"utf8",timeout:10000,maxBuffer:65536}).trim();
}
for (const name of new Set(scopes.map(s=>s.repositoryId))) {
  const dir=path.join(repoRoot,name.split("/")[1]);
  roots[name]=dir;
  if (!mode) {
    await fs.mkdir(path.join(dir,"docs/verified-learnings"),{recursive:true});
    git(dir,"init","-q"); git(dir,"config","user.name","Canary");
    git(dir,"config","user.email","canary@example.invalid");
    git(dir,"remote","add","origin","https://github.com/"+name+".git");
    for (let i=0;i<scopes.length;i++) if(scopes[i].repositoryId===name)
      await fs.writeFile(path.join(dir,"docs/verified-learnings/n"+i+".txt"),notes[i]);
    git(dir,"add","."); git(dir,"commit","-qm","Synthetic reviewed notes");
  }
}
const verifySource=createTrustedGitSourceVerifier({repositories:roots});
const journal=createPromotionJournal({root:journalRoot});
const keyPath=path.join(root,"key");
if (!mode) {
  await fs.mkdir(approvalRoot,{mode:0o700});
  await fs.writeFile(keyPath,randomBytes(32),{mode:0o600,flag:"wx"});
}
const key=await fs.readFile(keyPath);
assert.equal(key.length,32);
const store=createApprovedSourceStore({root:approvalRoot,key,verifySource,journal});
const runtime=await loadMemuRuntime();
const dsn="postgresql://bridge@/abr59_canary?host="+encodeURIComponent(env.PGHOST)+"&port=55439";
const nativeEnv={...env,HOME:path.join(root,"home"),MEMU_CONFIG_ENV:path.join(root,"no-config"),
  MEMU_DB:dsn,MEMU_MEMORY_MODE:"local",MEMU_EMBED_MODEL:"nomic-embed-text",
  MEMU_EMBED_PROVIDER:"openai",MEMU_BASE_URL:runtime.env.MEMU_BASE_URL,
  MEMU_API_KEY:"local",MEMU_TELEMETRY:"0"};
function nativeCommit(payload) {
  // No arbitrary DSN input or production fallback. The disposable cluster
  // was independently checked by psql above.
  return new Promise((resolve,reject)=>{
    const child=spawn(runtime.binary,["commit","-","--json"],{
      env:nativeEnv,cwd:root,shell:false,stdio:["pipe","pipe","pipe"]});
    let size=0, chunks=[],overflow=false, inputFailed=false;
    const timer=setTimeout(()=>{overflow=true;child.kill("SIGKILL");},60000);
    child.stdout.on("data",chunk=>{
      size+=chunk.length;
      if(size>65536){overflow=true;child.kill("SIGKILL");}
      else chunks.push(chunk);
    });
    child.stderr.on("data",()=>{}); // never persist potentially sensitive CLI diagnostics
    child.on("error",()=>{clearTimeout(timer);reject(Error("Disposable native memU spawn failed"))});
    child.stdin.on("error",()=>{inputFailed=true;child.kill("SIGKILL")});
    child.on("close",code=>{
      clearTimeout(timer);
      if(code!==0||overflow||inputFailed) {
        return reject(Error("Disposable native memU commit failed"));
      }
      try {resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))}
      catch{reject(Error("Invalid native memU result"))}
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
function githubFor(scope,sha) {
  return {
    async getPullRequest(){return {number:prNumber,state:"closed",merged:true,
      base:{repo:{full_name:scope.repositoryId}},head:{repo:{full_name:scope.repositoryId},sha},
      user:{login:"synthetic-author"},merge_commit_sha:sha};},
    async listReviews(){return [{id:1,state:"APPROVED",commit_id:sha,
      user:{login:"synthetic-reviewer"},submitted_at:"2026-01-01T00:00:00Z"}];},
    async listCheckRuns(){return [{id:1,name:requiredChecks[0],head_sha:sha,
      status:"completed",conclusion:"success",app:{slug:"github-actions"}}];},
    async getCollaboratorPermission(){return {permission:"write"};}
  };
}
const items=scopes.map((scope,i)=>{
  const sha=git(roots[scope.repositoryId],"rev-parse","HEAD");
  const source={scope,sourceGitSha:sha,sourcePath:"docs/verified-learnings/n"+i+".txt",
    revision:1,content:notes[i],expiresAt};
  const github=githubFor(scope,sha);
  const linear={async getIssue(id){return {id,statusType:"completed",
    repositoryId:scope.repositoryId,headSha:sha};}};
  return {scope,source,sha,id:promotionReceiptId({scope,prNumber,headSha:sha}),github,linear};
});
function args(item) {
  return {journal,journalRoot,github:item.github,linear:item.linear,
    scope:item.scope,prNumber,headSha:item.sha,requiredChecks,candidate:item.source,
    verifyCandidate:verifySource,commitImpl:nativeCommit};
}
if(!mode) {
  for(const item of items){
    const {receipt}=await journal.stageVerified({github:item.github,scope:item.scope,
      prNumber,expectedHeadSha:item.sha,requiredChecks});
    const result=await executeVerifiedMemuCommit(args(item));
    assert.equal(result.id,item.id);
    assert.equal(result.status,"commit-confirmed");
    assert.equal(await fs.readFile(path.join(journalRoot,item.id+".commit-confirmed"),"utf8"),result.digest);
    await store.approve({receipt,source:item.source});
  }
}
assert.equal(sql("SELECT count(*) FROM memu.recall_files"),String(items.length));
assert.equal(sql("SELECT count(DISTINCT (user_id,agent_id)) FROM memu.recall_files"),String(items.length));
assert.equal(sql("SELECT count(*) FROM memu.recall_files WHERE vector_dims(embedding)=768"),String(items.length));
assert.equal(sql("SELECT count(DISTINCT recall_file_id) FROM memu.recall_file_segments WHERE vector_dims(embedding)=768"),String(items.length));
// Direct injection replaces the production-only subprocess environment,
// retaining the exact production SQL, parameters, parsing and sanitizer.
function disposableSpawn(binary,argv,options){
  assert.equal(binary,"/usr/bin/psql");
  assert.equal(options.shell,false);
  return spawn(pg,argv,{...options,env});
}
async function recall(item,authority){
  return readScopedMemuFiles({scope:item.scope,...authority,spawnImpl:disposableSpawn});
}
const authorities=[];
for(const item of items){
  const authority=await store.load({scope:item.scope,receiptIds:[item.id]});
  authorities.push(authority);
  const identity=nativeScopedIdentity(item.scope);
  // Prove persisted row/segment labels, not just application-envelope rejection.
  // Values below are constrained synthetic hex/ASCII identifiers generated above.
  assert.match(identity.userId,/^[0-9a-f]{64}$/);
  assert.match(identity.agentId,/^[a-zA-Z0-9_-]+$/);
  assert.equal(sql("SELECT count(*) FROM memu.recall_files WHERE name='bridge-"+item.id+
    "' AND user_id='"+identity.userId+"' AND agent_id='"+identity.agentId+"'"),"1");
  assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments s JOIN memu.recall_files f ON f.id=s.recall_file_id WHERE f.name='bridge-"+item.id+
    "' AND (s.user_id IS DISTINCT FROM f.user_id OR s.agent_id IS DISTINCT FROM f.agent_id OR s.track IS DISTINCT FROM f.track)"),"0");
  // Inspect database output before independent approvals can discard rows.
  const raw=execFileSync(pg,["-X","-q","-A","-t","-v","ON_ERROR_STOP=1",
    "-v","scoped_user_id="+identity.userId,
    "-v","scoped_agent_id="+identity.agentId,"-f","-"],
    {env,input:makeScopedRecallSql(),encoding:"utf8",timeout:10000,maxBuffer:65536});
  const dbRows=JSON.parse(raw.trim());
  assert.deepEqual(dbRows.map(row=>row.name),["bridge-"+item.id]);
  const envelope=await recall(item,authority);
  assert.equal(envelope.entries.length,1);
  assert.equal(envelope.entries[0].content,item.source.content);
  assert.equal(envelope.trust,"untrusted-reference-only");
}
// Negative filter test: each of four changed dimensions is rejected even if
// the caller supplies the signed authority of the other scope.
for(let i=1;i<items.length;i++){
  await assert.rejects(store.load({scope:items[i].scope,receiptIds:[items[0].id]}),/foreign/);
  const envelope=await recall(items[i],authorities[0]);
  assert.equal(envelope.entries.length,0);
}
// Confirm persistent duplicates are rejected after initial and restarted runs.
let extraWrites=0;
await assert.rejects(executeVerifiedMemuCommit({...args(items[0]),
  commitImpl:async()=>{extraWrites++;throw Error("unexpected write");}}),/already attempted/);
assert.equal(extraWrites,0);
assert.equal(sql("SELECT count(*) FROM memu.recall_files"),String(items.length));
// Mutate one synthetic row, not its approval. Verify denial and restore.
const name="bridge-"+items[0].id;
const rowId=sql("SELECT id FROM memu.recall_files WHERE name='"+name+"'");
assert.match(rowId,/^[a-zA-Z0-9_-]+$/);
sql("UPDATE memu.recall_files SET content='Changed synthetic bytes' WHERE id='"+rowId+"'");
assert.equal((await recall(items[0],authorities[0])).entries.length,0);
sql("UPDATE memu.recall_files SET content='"+notes[0]+"' WHERE id='"+rowId+"'");
assert.equal((await recall(items[0],authorities[0])).entries.length,1);
console.log(JSON.stringify({phase:mode?"restart":"initial",nativeMemu:true,
  postgres:18,localEmbedding:"nomic-embed-text",dimensions:768,scopes:items.length,
  positiveRecalls:items.length,crossScopeDenials:items.length-1,
  tamperDenied:true,duplicateDenied:true,fixtureReviewEvidence:true}));
