import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {restrictedDbIdentity,createDisposableRestrictedMemuPersistence} from "../restricted-memu-persistence.mjs";
import {createPromotionJournal,promotionReceiptId} from "../promotion-journal.mjs";
import {executeVerifiedMemuCommit} from "../memu-commit-executor.mjs";
import {createApprovedSourceStore} from "../approved-source-store.mjs";
import {recallDigest} from "../scoped-recall.mjs";

const base={tenantId:"tenant-a",agentId:"agent-a",repositoryId:"Canary/memory",issueId:"CAN-1"};
const scopes=[base,{...base,tenantId:"tenant-b"},{...base,agentId:"agent-b"},
  {...base,repositoryId:"Canary/other"},{...base,issueId:"CAN-2"}];
const roles=scopes.map(restrictedDbIdentity);
if(process.argv[2]==="--roles"){
  console.log(roles.map(r=>[r.reader,r.writer,r.userId,r.agentId].join(" ")).join("\n"));
  process.exit(0);
}
assert.equal(process.getuid()===0,false);
const [socketRoot,root,mode]=process.argv.slice(2);
assert.match(socketRoot,/^\/var\/tmp\/abr59-m12\.[A-Za-z0-9]{8}$/);
assert.match(root,/^\/home\/bridge\/\.abr59-m12\.[A-Za-z0-9]{8}$/);
assert.ok([undefined,"--resume"].includes(mode));
assert.equal(await fs.realpath(root),root);
const pg="/usr/lib/postgresql/18/bin/psql";
const env={PATH:"/usr/bin:/bin",PGHOST:path.join(socketRoot,"socket"),PGPORT:"55441",PGDATABASE:"abr59_m12"};
function sql(query,role="postgres"){
  return execFileSync(pg,["-X","-qAt","-v","ON_ERROR_STOP=1","-c",query],{
    env:{...env,PGUSER:role},encoding:"utf8",timeout:10000,stdio:["ignore","pipe","pipe"]}).trim();
}
function rejected(query,role){assert.throws(()=>sql(query,role));}
assert.equal(sql("SELECT current_database(),current_user,inet_server_addr() IS NULL"),"abr59_m12|postgres|t");
assert.equal(sql("SHOW data_directory"),path.join(socketRoot,"data"));
assert.equal(sql("SELECT count(*) FROM memu.recall_files"),mode?"7":"0");
const sha="a".repeat(40),prNumber=1,requiredChecks=["synthetic-canary"];
const journalRoot=path.join(root,"journal"),approvalRoot=path.join(root,"approvals"),keyFile=path.join(root,"key");
if(!mode){
  await fs.mkdir(journalRoot,{mode:0o700});await fs.mkdir(approvalRoot,{mode:0o700});
  await fs.writeFile(keyFile,randomBytes(32),{mode:0o600,flag:"wx"});
}
const journal=createPromotionJournal({root:journalRoot});
const notes=scopes.map((scope,i)=>"Reviewed synthetic memory for isolated scope number "+i+".");
const items=scopes.map((scope,i)=>{
  const job={jobId:"synthetic-"+i,scope,prNumber,headSha:sha};
  const source={scope,sourceGitSha:sha,sourcePath:"docs/verified-learnings/n"+i+".txt",revision:1,
    content:notes[i],expiresAt:"2099-01-01T00:00:00Z"};
  const github={
    async getPullRequest(){return {number:prNumber,state:"closed",merged:true,head:{sha,repo:{full_name:scope.repositoryId}},
      base:{repo:{full_name:scope.repositoryId}},merge_commit_sha:sha,user:{login:"fixture-author"}};},
    async listReviews(){return [{id:1,state:"APPROVED",commit_id:sha,user:{login:"fixture-reviewer"},submitted_at:"2026-01-01T00:00:00Z"}];},
    async listCheckRuns(){return [{id:1,name:requiredChecks[0],head_sha:sha,status:"completed",conclusion:"success",app:{slug:"github-actions"}}];},
    async getCollaboratorPermission(){return {permission:"write"};}
  };
  const linear={async getIssue(id){return {id,statusType:"completed",repositoryId:scope.repositoryId,headSha:sha};}};
  return {job,source,github,linear,id:promotionReceiptId(job)};
});
const verifySource=async record=>items.some(i=>Object.keys(i.source.scope).every(k=>record.scope[k]===i.source.scope[k])&&
 (record.headSha??record.sourceGitSha)===i.source.sourceGitSha&&record.sourcePath===i.source.sourcePath&&record.content===i.source.content&&record.revision===1);
const store=createApprovedSourceStore({root:approvalRoot,key:await fs.readFile(keyFile),verifySource,journal});
const partialJob={...items[0].job,jobId:"synthetic-interrupted",prNumber:2};
const partialId=promotionReceiptId(partialJob);
const partialGithub={...items[0].github,async getPullRequest(){
  return {...await items[0].github.getPullRequest(),number:2};
}};
const partialArgs=commitImpl=>({journal,journalRoot,github:partialGithub,linear:items[0].linear,
 scope:partialJob.scope,prNumber:2,headSha:sha,requiredChecks,candidate:items[0].source,
 verifyCandidate:verifySource,commitImpl});
const adapters=await Promise.all(items.map(i=>createDisposableRestrictedMemuPersistence({job:i.job,root,socketRoot})));
function args(i,commitImpl){const item=items[i];return {journal,journalRoot,github:item.github,linear:item.linear,
  scope:item.job.scope,prNumber,headSha:sha,requiredChecks,candidate:item.source,verifyCandidate:verifySource,commitImpl};}
if(!mode){
  for(let i=0;i<items.length;i++){
    const item=items[i],a=adapters[i];
    const {receipt}=await journal.stageVerified({github:item.github,scope:item.job.scope,prNumber,expectedHeadSha:sha,requiredChecks});
    const result=await executeVerifiedMemuCommit(args(i,a.commit));
    assert.equal(result.status,"commit-confirmed");
    await store.approve({receipt,source:item.source});
  }
  // Simulate a connection loss after native memU's first transaction
  // creates a file row, before its separate segment transaction completes.
  const {receipt:partialReceipt}=await journal.stageVerified({github:partialGithub,scope:partialJob.scope,
    prNumber:2,expectedHeadSha:sha,requiredChecks});
  const original=items[0],writer=roles[0].writer;
  await assert.rejects(executeVerifiedMemuCommit(partialArgs(async payload=>{
    assert.equal(payload.recall_files[0].name,"bridge-"+partialId);
    sql("INSERT INTO memu.recall_files(id,created_at,updated_at,name,track,description,content,user_id,agent_id,embedding) SELECT 'partial-native',now(),now(),'bridge-"+partialId+"',track,description,content,user_id,agent_id,embedding FROM memu.recall_files WHERE name='bridge-"+original.id+"'",writer);
    throw Error("simulated uncertain native segment transaction");
  })),/manual reconciliation/);
  await assert.rejects(store.approve({receipt:partialReceipt,source:original.source}),/confirm|commit/i);
  assert.equal(await fs.readFile(path.join(journalRoot,partialId+".commit-started"),"utf8").then(x=>x.length),64);
  await assert.rejects(fs.stat(path.join(journalRoot,partialId+".commit-confirmed")),{code:"ENOENT"});
  // A same-scope unapproved row with valid shape is deliberately preserved;
  // approved-ID filtering must stop it at the SQL boundary.
  const r=roles[0],name="bridge-"+"f".repeat(64);
  sql("INSERT INTO memu.recall_files(id,created_at,updated_at,name,track,description,content,user_id,agent_id,embedding) SELECT 'unapproved',now(),now(),'"+name+"',track,description,content,user_id,agent_id,embedding FROM memu.recall_files WHERE name='bridge-"+items[0].id+"'; INSERT INTO memu.recall_file_segments(id,created_at,updated_at,recall_file_id,track,text,user_id,agent_id,embedding) SELECT 'unapproved-segment',now(),now(),'unapproved',track,text,user_id,agent_id,embedding FROM memu.recall_file_segments WHERE user_id='"+r.userId+"' AND agent_id='"+r.agentId+"';");
}
assert.equal(sql("SELECT count(*) FROM memu.recall_files"),"7");
assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments"),"6");
assert.equal(sql("SELECT count(*) FROM memu.recall_files WHERE public.vector_dims(embedding)=768"),"7");
assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments WHERE public.vector_dims(embedding)=768"),"6");
for(let i=0;i<items.length;i++){
  const item=items[i],r=roles[i];
  // Actual authenticated reader/writer sessions, not SET ROLE from a superuser.
  for(const role of [r.reader,r.writer]){
    assert.equal(sql("SELECT session_user,current_user,inet_server_addr() IS NULL",role),role+"|"+role+"|t");
    assert.equal(sql("SELECT count(*) FROM memu.recall_files",role),i===0?"3":"1");
    assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments",role),i===0?"2":"1");
    for(let j=0;j<items.length;j++)if(j!==i){
      assert.equal(sql("SELECT count(*) FROM memu.recall_files WHERE name='bridge-"+items[j].id+"'",role),"0");
      assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments s JOIN memu.recall_files f ON f.id=s.recall_file_id WHERE f.name='bridge-"+items[j].id+"'",role),"0");
    }
    rejected("SET ROLE "+roles[(i+1)%items.length].writer,role);
    rejected("SELECT * FROM bridge_memory_auth.scope_login",role);
    rejected("SELECT * FROM memu.resources",role);
    rejected("ALTER TABLE memu.recall_files DISABLE ROW LEVEL SECURITY",role);
    rejected("TRUNCATE memu.recall_files CASCADE",role);
    rejected("CREATE TABLE memu.evil(x int)",role);
    rejected("SET row_security=off; SELECT count(*) FROM memu.recall_files",role);
    // Arbitrary GUCs cannot change the session_user-bound scope.
    assert.equal(sql("SET bridge.scope='foreign'; SELECT count(*) FROM memu.recall_files",role),i===0?"3":"1");
  }
  rejected("UPDATE memu.recall_files SET content='tampered'",r.reader);
  rejected("DELETE FROM memu.recall_file_segments",r.reader);
  rejected("INSERT INTO memu.recall_files SELECT * FROM memu.recall_files",r.reader);
  rejected("UPDATE memu.recall_files SET user_id='"+roles[(i+1)%items.length].userId+"'",r.writer);
  rejected("DELETE FROM memu.recall_files",r.writer);
  rejected("INSERT INTO memu.recall_files(id,created_at,updated_at,name,track,description,user_id,agent_id) VALUES ('foreign',now(),now(),'bridge-"+"e".repeat(64)+"','memory','foreign','"+roles[(i+1)%items.length].userId+"','"+roles[(i+1)%items.length].agentId+"')",r.writer);
  const foreignId=sql("SELECT id FROM memu.recall_files WHERE name='bridge-"+items[(i+1)%items.length].id+"'");
  assert.match(foreignId,/^[A-Za-z0-9_-]+$/);
  rejected("INSERT INTO memu.recall_file_segments(id,created_at,updated_at,recall_file_id,track,text,user_id,agent_id) VALUES ('foreign-segment',now(),now(),'"+foreignId+"','memory','foreign','"+r.userId+"','"+r.agentId+"')",r.writer);
  const auth=await store.load({scope:item.job.scope,receiptIds:[item.id]});
  const recalled=await adapters[i].recall(auth);
  assert.equal(recalled.entries.length,1);assert.equal(recalled.entries[0].content,item.source.content);
  if(i!==0)await assert.rejects(adapters[i].recall(await store.load({scope:items[0].job.scope,receiptIds:[items[0].id]})));
}
const auth=await store.load({scope:items[0].job.scope,receiptIds:[items[0].id]});
// A valid reader must pass named preflight, while an extra otherwise harmless
// group membership is refused. Restore fixture grants before subsequent checks.
sql("CREATE ROLE fixture_extra NOLOGIN; GRANT fixture_extra TO "+roles[0].reader+" WITH INHERIT TRUE, SET FALSE");
try{
  await assert.rejects(adapters[0].recall(auth),/Restricted memU persistence denied/);
}finally{
  sql("REVOKE fixture_extra FROM "+roles[0].reader+"; DROP ROLE fixture_extra");
}
assert.equal((await adapters[0].recall(auth)).entries.length,1);
const f="bridge-"+items[0].id;
sql("UPDATE memu.recall_file_segments SET text='tampered' WHERE recall_file_id=(SELECT id FROM memu.recall_files WHERE name='"+f+"')");
assert.equal((await adapters[0].recall(auth)).entries.length,0);
sql("UPDATE memu.recall_file_segments SET text='"+notes[0]+"' WHERE recall_file_id=(SELECT id FROM memu.recall_files WHERE name='"+f+"')");
assert.equal((await adapters[0].recall(auth)).entries.length,1);
let writes=0;
await assert.rejects(executeVerifiedMemuCommit(args(0,async()=>{writes++;throw Error("unexpected");})),/already attempted/);
assert.equal(writes,0);
await assert.rejects(executeVerifiedMemuCommit(partialArgs(async()=>{writes++;throw Error("unexpected retry");})),/already attempted/);
assert.equal(writes,0);
assert.equal(sql("SELECT count(*) FROM memu.recall_file_segments WHERE recall_file_id='partial-native'"),"0");
const partialAdapter=await createDisposableRestrictedMemuPersistence({job:partialJob,root,socketRoot});
assert.equal((await partialAdapter.recall({approvedSources:new Map([[partialId,items[0].source]]),
 trustedDigests:new Set([recallDigest(items[0].source)])})).entries.length,0);

console.log(JSON.stringify({phase:mode?"restart":"initial",scopes:5,restrictedLogins:10,
  positiveRecalls:5,foreignScopeDenials:40,unapprovedIdFiltered:true,readerWriteDenied:true,
  writerForeignWriteDenied:true,segmentTamperDenied:true,duplicateDenied:true,uncertainCommitDenied:true,unexpectedMembershipDenied:true,nativeMemu:true,fixtureReviewEvidence:true}));
