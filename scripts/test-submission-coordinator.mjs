// ABR-17 M1: actual canonical job ledger and transactional outbox; all external
// effects are injected fixtures, never real GitHub, Linear, Worker or agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobStore } from '../jobs/persistence/job-store.mjs';
import { createSubmissionOutbox } from '../jobs/persistence/submission-outbox.mjs';
import { createSubmissionCoordinator } from '../bridge/orchestration/submission-coordinator.mjs';

const A='a'.repeat(40),B='b'.repeat(40);
const BASE=Object.freeze({jobKey:'antigravity:fixture-job',sessionId:'fixture-session',
  issueUuid:'d6447556-9387-4bcf-b9b4-4ac160aa1939',issueIdentifier:'ABR-17',
  tenantId:'fixture-tenant',agentId:'antigravity',role:'coding',
  hostId:'rebel-server',repository:'REVREBEL/linear-agents',repositoryRoot:'/fixture/repo',
  branch:'feat/abr-17',base:'main',installationId:'12345',appId:'45678',cycle:'cycle-1',
  headSha:A,expiresAt:2_000_000});
const receipt=(stage,{scope:s,github})=>{
  const common={verified:true};
  switch(stage){
    case 'inspectGit':return {...common,repository:s.repository,repositoryRoot:s.repositoryRoot,
      branch:s.branch,base:s.base,headSha:s.headSha,remoteHeadSha:s.headSha,
      clean:true,detached:false,conflicts:false,checksPassed:true,installationId:s.installationId,appId:s.appId};
    case 'publishGitHub':return {...common,number:42,repository:s.repository,branch:s.branch,base:s.base,
      headSha:s.headSha,installationId:s.installationId,appId:s.appId,state:'open',draft:false,
      url:'https://github.com/'+s.repository+'/pull/42'};
    case 'postLinear':return {...common,issueUuid:s.issueUuid,commentId:'comment-'+s.cycle,
      headSha:s.headSha,agentId:s.agentId};
    case 'moveInReview':return {...common,issueUuid:s.issueUuid,state:'In Review',agentId:s.agentId};
    case 'queueReview':return {...common,repository:s.repository,number:github.number,
      headSha:s.headSha,reviewId:'review-'+s.cycle};
    case 'closeSession':return {...common,sessionId:s.sessionId,status:'completed',agentId:s.agentId};
    default:throw Error('unknown fixture stage');
  }
};
const stages=['inspectGit','publishGitHub','postLinear','moveInReview','queueReview','closeSession'];
const pending=['git_ready','github_published','linear_posted','in_review','review_queued','session_closed'];
const input={issueId:BASE.issueIdentifier,summary:'Implemented source fixture'};
async function setup(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'abr17-'));
  const jobStore=createJobStore(root),trustedAdmissions=new WeakMap(),observations=new WeakMap();
  const open=new Set(),calls=[],contexts=new Map(),effects=new Map();
  const originalGet=jobStore.get.bind(jobStore);
  let holdRead=null;
  jobStore.get=async key=>{
    const record=await originalGet(key);
    const hold=holdRead;
    if(hold && --hold.remaining===0){
      holdRead=null;
      hold.entered();
      await hold.release;
    }
    return record;
  };
  function holdLedgerRead(n=1){
    let entered,resume;
    const waiting=new Promise(r=>{entered=r;});
    const release=new Promise(r=>{resume=r;});
    holdRead={remaining:n,entered,release};
    return {waiting,resume};
  }

  let clock=1_990_000, fail=null, transform=null, suspend=null;
  t.after(async()=>{for(const store of open)store.close();await rm(root,{recursive:true,force:true});});
  async function record(s=BASE){
    await jobStore.claim(s.jobKey,{agent:s.agentId,agentSessionId:s.sessionId,
      issueId:s.issueUuid,issueIdentifier:s.issueIdentifier,tenantId:s.tenantId,
      executionHost:s.hostId,repositoryId:s.repository,repositoryRoot:s.repositoryRoot,
      branch:s.branch,baseBranch:s.base,githubInstallationId:s.installationId,
      githubAppId:s.appId,submissionCycle:s.cycle,expectedHeadSha:s.headSha});
    await jobStore.transition(s.jobKey,'running');
  }
  await record();
  function admission(s=BASE){const proof={};trustedAdmissions.set(proof,s);return proof;}
  const adapters=Object.fromEntries(stages.map(stage=>[stage,async context=>{
    calls.push(stage);contexts.set(stage,context);
    if(suspend&&stage===suspend.stage)await suspend.pause;
    const result=receipt(stage,context);
    const value=transform===null?result:transform(stage,result);
    effects.set(context.operationId,value);
    if(stage===fail)throw Error('ambiguous network error incl fixture credential');
    return value;
  }]));
  function connect(enabled=true) {
    const outbox=createSubmissionOutbox(root);open.add(outbox);
    const coordinator=createSubmissionCoordinator({jobStore,outbox,enabled,adapters,
      verifyAdmission:proof=>trustedAdmissions.get(proof),
      verifyRecovery:proof=>observations.get(proof),
      now:()=>clock});
    return {outbox,coordinator};
  }
  const connection=connect();
  const handle=await connection.coordinator.bind(admission());
  function observation(stage){
    const proof={},context=contexts.get(stage);
    observations.set(proof,{confirmed:true,stage:pending[stages.indexOf(stage)],
      operationId:context.operationId,receipt:effects.get(context.operationId)});
    return proof;
  }
  return {root,jobStore,calls,contexts,record,admission,connect,handle,...connection,
    failAt:stage=>{fail=stage;},mutate:fn=>{transform=fn;},
    pauseAt:stage=>{let resume;suspend={stage,pause:new Promise(r=>{resume=r;})};return resume;},
    observation,holdLedgerRead,expire:()=>{clock=2_000_001;}};
}
test('ABR-17 disabled by default; no forged/interactive/wrong-issue/expired capability',async t=>{
  const x=await setup(t);
  await assert.rejects(x.connect(false).coordinator.bind(x.admission()),/SUBMISSION_DISABLED/);
  await assert.rejects(x.coordinator.bind({...BASE}),/UNVERIFIED_SUBMISSION_ADMISSION/);
  await assert.rejects(x.coordinator.bind(x.admission({...BASE,role:'review'})),/UNVERIFIED_SUBMISSION_ADMISSION/);
  await assert.rejects(x.coordinator.submit({},input),/SUBMISSION_CAPABILITY_REQUIRED/);
  await assert.rejects(x.coordinator.submit(x.handle,{...input,issueId:'ABR-18'}),/ISSUE_CONFIRMATION/);
  await assert.rejects(x.coordinator.submit(x.handle,{...input,prNumber:42}),/ISSUE_CONFIRMATION/);
  for(const [field,value] of [['tenantId','other'],['agentId','trae'],['repository','OTHER/repo'],
    ['repositoryRoot','/other'],['hostId','macos-runtime'],['sessionId','another'],
    ['branch','feat/another'],['installationId','765'],['appId','987'],['headSha',B]]){
    await assert.rejects(x.coordinator.bind(x.admission({...BASE,[field]:value})),/JOB_SCOPE_MISMATCH/);
  }
  x.expire();
  await assert.rejects(x.coordinator.submit(x.handle,input),/SUBMISSION_CAPABILITY_REQUIRED/);
  assert.deepEqual(x.calls,[]);
});
test('ABR-17 ready submission: durable order, secret redaction, retry and exact revision PR',async t=>{
  const x=await setup(t);
  const submission={...input,summary:'Verified work token=SECRET_TOKEN'};
  const first=await x.coordinator.submit(x.handle,submission);
  assert.equal(first.stage,'session_closed');
  assert.equal(first.prNumber,42);
  assert.equal(first.reviewQueued,true);assert.equal(first.reviewerAcknowledged,false);
  assert.equal(first.issueCompleted,false);
  assert.deepEqual(x.calls,stages);
  assert.ok(!JSON.stringify(x.outbox.get(first.submissionId)).includes('SECRET_TOKEN'));
  assert.ok(!x.contexts.get('publishGitHub').summary.includes('SECRET_TOKEN'));
  const mode=(await stat(path.join(x.root,'job-state','submission-outbox.sqlite'))).mode&0o777;
  assert.equal(mode,0o600);
  await x.jobStore.transition(BASE.jobKey,'completed');
  assert.equal((await x.coordinator.submit(x.handle,submission)).submissionId,first.submissionId);
  assert.equal(x.calls.length,6);
  await assert.rejects(x.coordinator.submit(x.handle,{...submission,summary:'changed'}),/RECEIPT_CONFLICT/);
  // No-change revisions are rejected, even with a different session and cycle.
  const second={...BASE,jobKey:'antigravity:job2',sessionId:'session2',cycle:'cycle-2'};
  await x.record(second);
  const h=await x.coordinator.bind(x.admission(second));
  await assert.rejects(x.coordinator.submit(h,input),/HEAD_ALREADY_RECORDED/);
  const rev={...second,jobKey:'antigravity:job3',sessionId:'session3',headSha:B,cycle:'cycle-3'};
  await x.record(rev);
  const h3=await x.coordinator.bind(x.admission(rev));
  const third=await x.coordinator.submit(h3,input);
  assert.equal(third.prNumber,42);assert.equal(third.headSha,B);
  assert.equal(x.contexts.get('publishGitHub').previousPr.headSha,A);
  assert.equal(x.outbox.get(third.submissionId).github.previousHeadSha,A);
  assert.equal(x.calls.length,12);
});
test('ABR-17 dirty/detached/check failure and wrong mapped app fail before publication',async t=>{
  for(const change of [{clean:false},{detached:true},{conflicts:true},{checksPassed:false},
    {remoteHeadSha:B},{appId:'999'},{installationId:'999'}]){
    await t.test(JSON.stringify(change),async child=>{
      const x=await setup(child);
      x.mutate((stage,value)=>stage==='inspectGit'?{...value,...change}:value);
      const r=await x.coordinator.submit(x.handle,input);
      assert.equal(r.status,'reconciliation_required');
      assert.equal(r.pending,'git_ready');
      assert.deepEqual(x.calls,['inspectGit']);
    });
  }
});
test('ABR-17 ambiguous network responses at every external stage never replay on restart',async t=>{
  for(const [index,stage] of stages.entries()){
    await t.test(stage,async child=>{
      const x=await setup(child);
      x.failAt(stage);
      const one=await x.coordinator.submit(x.handle,input);
      assert.equal(one.pending,pending[index]);
      assert.equal(one.status,'reconciliation_required');
      assert.equal(x.calls.length,index+1);
      const restarted=x.connect();
      const h=await restarted.coordinator.bind(x.admission());
      const repeat=await restarted.coordinator.submit(h,input);
      assert.equal(repeat.submissionId,one.submissionId);
      assert.equal(repeat.pending,one.pending);
      assert.equal(x.calls.length,index+1);
      await assert.rejects(restarted.coordinator.reconcilePending(h,{}),/UNVERIFIED_SUBMISSION_RECONCILIATION/);
      const recovered=await restarted.coordinator.reconcilePending(h,x.observation(stage));
      assert.equal(recovered.stage,pending[index]);
      x.failAt(null);
      const final=await restarted.coordinator.submit(h,input);
      assert.equal(final.stage,'session_closed');
      assert.deepEqual(x.calls,stages,'No external effect repeated');
    });
  }
});
test('ABR-17 one issue claim across SQLite connections and identical concurrent requests',async t=>{
  const x=await setup(t);
  const resume=x.pauseAt('publishGitHub');
  const issuing=x.coordinator.submit(x.handle,input);
  try{
    while(!x.calls.includes('publishGitHub'))await new Promise(r=>setTimeout(r,1));
    const other=x.connect();
    const h=await other.coordinator.bind(x.admission());
    const duplicate=await other.coordinator.submit(h,input);
    assert.equal(duplicate.pending,'github_published');
    assert.equal(x.calls.filter(n=>n==='publishGitHub').length,1);
    await assert.rejects(other.coordinator.submit(h,{...input,summary:'different'}),/RECEIPT_CONFLICT/);
    const conflict={...BASE,jobKey:'trae:second',sessionId:'s2',agentId:'trae',headSha:B,cycle:'c2'};
    await x.record(conflict);
    const h2=await other.coordinator.bind(x.admission(conflict));
    await assert.rejects(other.coordinator.submit(h2,input),/ISSUE_SUBMISSION_IN_PROGRESS/);
  }finally{resume();}
  assert.equal((await issuing).stage,'session_closed');
  assert.deepEqual(x.calls,stages);
});
test('ABR-17 wrong publication receipt or changed job never advances to Linear',async t=>{
  const x=await setup(t);
  x.mutate((stage,value)=>stage==='publishGitHub'?{...value,repository:'OTHER/repo'}:value);
  const r=await x.coordinator.submit(x.handle,input);
  assert.equal(r.pending,'github_published');
  assert.deepEqual(x.calls,stages.slice(0,2));
  await assert.rejects(x.coordinator.reconcilePending(x.handle,x.observation('publishGitHub')),/UNVERIFIED_GITHUB_PUBLICATION/);
  await x.jobStore.transition(BASE.jobKey,'failed');
  await assert.rejects(x.coordinator.submit(x.handle,input),/JOB_SCOPE_MISMATCH/);
});


test('ABR-17 revocation or expiry during ledger I/O cannot authorize any next adapter',async t=>{
  for(const mode of ['revoke','expire']){
    for(const [label,n,priorCalls] of [
      ['initial claim',1,0],['validation',2,0],
      ['git inspection',3,0],['GitHub publication',4,1],
      ['Linear comment',5,2],['Linear transition',6,3],
      ['review queue',7,4],['Worker completion',8,5],
    ]){
      await t.test(mode+' during '+label,async child=>{
        const x=await setup(child);
        const held=x.holdLedgerRead(n);
        const submission=x.coordinator.submit(x.handle,input);
        await held.waiting;
        if(mode==='revoke') x.coordinator.revoke(x.handle);
        else x.expire();
        held.resume();
        await assert.rejects(submission,/SUBMISSION_CAPABILITY_REQUIRED/);
        assert.deepEqual(x.calls,stages.slice(0,priorCalls));
      });
    }
  }
});
test('ABR-17 recovery cannot advance a pending intent after revocation during either ledger read',async t=>{
  for(const n of [1,2]){
    await t.test('held recovery lookup '+n,async child=>{
      const x=await setup(child);
      x.failAt('publishGitHub');
      const first=await x.coordinator.submit(x.handle,input);
      assert.equal(first.pending,'github_published');
      const held=x.holdLedgerRead(n);
      const recovery=x.coordinator.reconcilePending(x.handle,x.observation('publishGitHub'));
      await held.waiting;
      x.coordinator.revoke(x.handle);
      held.resume();
      await assert.rejects(recovery,/SUBMISSION_CAPABILITY_REQUIRED/);
      assert.equal(x.outbox.get(first.submissionId).pending,'github_published');
      assert.deepEqual(x.calls,stages.slice(0,2));
    });
  }
});
test('ABR-17 admission expires during ledger lookup before handle minting',async t=>{
  const x=await setup(t);
  const held=x.holdLedgerRead();
  const binding=x.coordinator.bind(x.admission());
  await held.waiting;
  x.expire();
  held.resume();
  await assert.rejects(binding,/UNVERIFIED_SUBMISSION_ADMISSION/);
  assert.deepEqual(x.calls,[]);
});
