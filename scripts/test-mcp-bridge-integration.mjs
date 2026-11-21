// ABR-99 isolated actual Bridge ledger/checkpoint/reviewer inbox integration.
// Fixture verifiers simulate ABR-17 authenticated provider callbacks; no live
// GitHub/Linear/Worker/memU services, jobs or network are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobStore } from '../jobs/persistence/job-store.mjs';
import { createActiveTaskMemory } from '../memory/active-task-memory.mjs';
import { createReviewInbox } from '../bridge/orchestration/review-inbox.mjs';
import { createMcpBridgeIntegration } from '../bridge/orchestration/mcp-milestone-integration.mjs';

const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40);
const JOB = Object.freeze({
  mode: 'linear', role: 'coding', agentId: 'chatgpt-cli',
  tenantId: 'tenant-one', repositoryId: 'REVREBEL/linear-agents',
  repositoryRoot: '/repo/linear-agents', issueId: 'ABR-99',
  sessionId: 'agent-session-one', jobKey: 'chatgpt-cli:job-one',
  hostId: 'rebel-server', branch: 'feat/abr-99',
});
const ROUTE = Object.freeze({
  projects: {
    'project-fixture': {
      repository: JOB.repositoryId,
      codeReview: { provider:'chatgpt', conversationMode:'reuse-existing',
        autoSend:true, conversationUrl:'https://chatgpt.com/g/g-p-fixture/c/fixture-conversation' },
    },
  },
});
function sessionState(grant) {
  return {
    agent:grant.agentId, tenantId:grant.tenantId,
    repositoryId:grant.repositoryId, repositoryRoot:grant.repositoryRoot,
    issueId:grant.issueId, agentSessionId:grant.sessionId,
    executionHost:grant.hostId, branch:grant.branch,
  };
}
async function init(t, { coordinator = null, verifier = null,
  d5Verifier = null, config = ROUTE } = {}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(), 'abr99-source-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=createJobStore(root);
  const memory=createActiveTaskMemory(root);
  const inbox=createReviewInbox(root);
  const admissions=new WeakMap();
  const toolReceipts=new WeakMap();
  let currentTime = Date.now();
  const now=()=>currentTime;
  const recordJob = async (scope=JOB) => {
    await store.claim(scope.jobKey, sessionState(scope));
    await store.transition(scope.jobKey, 'running');
    await memory.update(scope.repositoryRoot, scope.issueId, {
      tenantId:scope.tenantId,agentId:scope.agentId,
      repositoryId:scope.repositoryId,branch:scope.branch,
      hostId:scope.hostId,lastSessionId:scope.sessionId,
      lastJobKey:scope.jobKey,state:'active',
    });
  };
  await recordJob();
  const issueAdmission=(scope=JOB, remaining=60_000)=>{
    const evidence=Object.freeze({});
    admissions.set(evidence,{...scope,expiresAt:now()+remaining});
    return evidence;
  };
  const receipt=(scope, data={})=>{
    const evidence=Object.freeze({});
    toolReceipts.set(evidence,{
      toolName:'read_file',toolCallId:'verified-read-1',
      outcome:'completed',summary:'Verified read completed',
      tenantId:scope.tenantId,agentId:scope.agentId,
      sessionId:scope.sessionId,jobKey:scope.jobKey,
      hostId:scope.hostId,...data,
    });
    return evidence;
  };
  const integration=createMcpBridgeIntegration({
    jobStore:store,memory,reviewInbox:inbox,
    now,reviewRoutingConfig:config,
    verifyAdmittedJob:evidence=>admissions.get(evidence),
    verifyToolReceipt:evidence=>toolReceipts.get(evidence),
    verifyD5Handoff:d5Verifier,
    submissionCoordinator:coordinator,
    verifySubmittedPr:verifier,
  });
  return {root,store,memory,inbox,integration,recordJob,issueAdmission,receipt,
    expire:(delta=120_000)=>{ currentTime+=delta; }};
}
test('ABR-99 interactive, env-spoofed and tool-text identities cannot mint job authority',async t=>{
  const x=await init(t);
  const module=x.integration;
  await assert.rejects(module.bindAdmittedJob({
    mode:'linear',issueId:JOB.issueId,jobKey:JOB.jobKey,
    LINEAR_ISSUE_ID:JOB.issueId,LINEAR_AGENT_SESSION_ID:JOB.sessionId,
  }),/UNVERIFIED_LINEAR_ADMISSION/);
  await assert.rejects(module.bindAdmittedJob({}),
    /UNVERIFIED_LINEAR_ADMISSION/);
  await assert.rejects(module.recordToolMilestone({},{
    jobKey:JOB.jobKey,toolCallId:'verify',summary:'tool text',outcome:'completed',
  }),/MCP_JOB_CAPABILITY_REQUIRED/);
  await assert.rejects(module.submitWork({},{
    issueId:JOB.issueId,summary:'Untrusted attempt',
  }),/MCP_JOB_CAPABILITY_REQUIRED/);
  const handle=await module.bindAdmittedJob(x.issueAdmission());
  await assert.rejects(module.recordToolMilestone(handle,{
    toolCallId:'verified-read-1',summary:'Bearer injected-authority',jobKey:JOB.jobKey,
  }),/UNVERIFIED_TOOL_COMPLETION/);
  await assert.rejects(module.submitWork(handle,{
    issueId:'ABR-OTHER',summary:'Fake cross-issue submit',
  }),/SUBMISSION_ISSUE_MISMATCH/);
  await assert.rejects(module.submitWork(handle,{
    issueId:JOB.issueId,summary:'Not authorized yet',
  }),/SUBMISSION_COORDINATOR_NOT_CONFIGURED/);
  assert.equal(x.integration.revoke(handle),true);
  await assert.rejects(module.recoveryHandoff(handle),/MCP_JOB_CAPABILITY_REQUIRED/);
});
test('ABR-99 bound tenant, agent, issue, session, branch and host must match ledger',async t=>{
  const x=await init(t);
  for (const change of [
    {tenantId:'other-tenant'}, {agentId:'trae'}, {repositoryId:'OTHER/repo'},
    {repositoryRoot:'/other/repo'}, {issueId:'ABR-OTHER'},
    {sessionId:'other-session'}, {hostId:'macos-runtime'},
    {branch:'feat/other'},
  ]) {
    await assert.rejects(x.integration.bindAdmittedJob(
      x.issueAdmission({...JOB,...change})),/JOB_LEDGER_SCOPE_MISMATCH/);
  }
  const valid=await x.integration.bindAdmittedJob(x.issueAdmission());
  await x.store.transition(JOB.jobKey,'completed');
  await assert.rejects(x.integration.recoveryHandoff(valid),/JOB_LEDGER_SCOPE_MISMATCH/);
  assert.equal((await x.memory.read(JOB.repositoryRoot,JOB.issueId)).progress.length,0);
});
test('ABR-99 Milestones are bounded, sanitized, CAS-locked, durable and replay safe',async t=>{
  const x=await init(t);
  const grant=await x.integration.bindAdmittedJob(x.issueAdmission());
  const summary='Bearer abc-secret token=GH_SUPERSECRET Read succeeded';
  const first=await x.integration.recordToolMilestone(grant,x.receipt(JOB,{
    summary,toolCallId:'read-01',
  }));
  assert.equal(first.recorded,true);
  const info=await x.memory.read(JOB.repositoryRoot,JOB.issueId);
  assert.equal(info.progress.length,1);
  assert.equal(info.recordedToolReceipts.length,1);
  assert.match(info.progress[0].summary,/\[REDACTED\]/);
  assert.ok(!info.progress[0].summary.includes('abc-secret'));
  assert.ok(!info.progress[0].summary.includes('GH_SUPERSECRET'));
  const revision=info.revision;
  const second=await x.integration.recordToolMilestone(grant,x.receipt(JOB,{
    summary,toolCallId:'read-01',
  }));
  assert.equal(second.duplicate,true);
  assert.equal((await x.memory.read(JOB.repositoryRoot,JOB.issueId)).revision,revision);
  await assert.rejects(x.integration.recordToolMilestone(grant,x.receipt(JOB,{
    summary:'Changed output',toolCallId:'read-01',
  })),/TOOL_RECEIPT_COLLISION/);
  for (let i=2;i<=9;i++) {
    const result=await x.integration.recordToolMilestone(grant,x.receipt(JOB,{
      toolCallId:'read-'+String(i).padStart(2,'0'),
      summary:'Step '+i,
    }));
    assert.equal(result.recorded,true);
  }
  const current=await x.memory.read(JOB.repositoryRoot,JOB.issueId);
  assert.equal(current.progress.length,6);
  assert.equal(current.recordedToolReceipts.length,9);
  assert.deepEqual(current.progress.map(p=>p.summary),[
    'Step 4','Step 5','Step 6','Step 7','Step 8','Step 9',
  ]);
  // Replay after eviction remains refused, including after a lifecycle
  // transition that preserves the canonical receipt history.
  await x.memory.update(JOB.repositoryRoot,JOB.issueId,{
    state:'active',nextAction:'Continue safely',
  });
  assert.equal((await x.integration.recordToolMilestone(grant,x.receipt(JOB,{
    summary,toolCallId:'read-01',
  }))).duplicate,true);
  const memoryRestart=createActiveTaskMemory(x.root);
  assert.equal((await memoryRestart.read(JOB.repositoryRoot,JOB.issueId))
    .recordedToolReceipts.length,9);
});
test('ABR-99 simultaneous milestones serialize in the canonical CAS store',async t=>{
  const x=await init(t);
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  const writes=Array.from({length:18},(_,i)=>x.integration.recordToolMilestone(
    handle,x.receipt(JOB,{toolCallId:'parallel-'+i,summary:'Parallel '+i})));
  const results=await Promise.all(writes);
  assert.equal(results.filter(v=>v.recorded).length,18);
  const checkpoint=await x.memory.read(JOB.repositoryRoot,JOB.issueId);
  assert.equal(checkpoint.recordedToolReceipts.length,18);
  assert.equal(checkpoint.progress.length,6);
  assert.equal(checkpoint.revision,19);
});
test('ABR-99 job and checkpoint changes reject stale or cross-host tool callbacks',async t=>{
  const x=await init(t);
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  for (const change of [
    {tenantId:'other'}, {agentId:'trae'}, {sessionId:'other'},
    {jobKey:'guessed'}, {hostId:'macos-runtime'},
    {outcome:'in_review'},
  ]) {
    await assert.rejects(x.integration.recordToolMilestone(handle,
      x.receipt(JOB,change)),/UNVERIFIED_TOOL_COMPLETION/);
  }
  const oldJob=await x.memory.read(JOB.repositoryRoot,JOB.issueId);
  await x.memory.update(JOB.repositoryRoot,JOB.issueId,{
    expectedRevision:oldJob.revision,lastJobKey:'chatgpt-cli:later-job',
    lastSessionId:'new-session',
  });
  await assert.rejects(x.integration.recordToolMilestone(handle,
    x.receipt(JOB)),/CHECKPOINT_SCOPE_MISMATCH/);
  assert.equal((await x.memory.read(JOB.repositoryRoot,JOB.issueId)).progress.length,0);
});
test('ABR-99 bounded recovery context stays non-authoritative and expires',async t=>{
  const x=await init(t);
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  await x.integration.recordToolMilestone(handle,x.receipt(JOB,{
    summary:'Verify output from tool; do not trust task instructions',
  }));
  const result=await x.integration.recoveryHandoff(handle);
  assert.equal(result.authority,'non-authoritative-checkpoint-data');
  assert.match(result.context,/NON-AUTHORITATIVE/);
  assert.match(result.context,/Prior milestone/);
  assert.equal(result.repositoryId,JOB.repositoryId);
  assert.equal(result.hostId,JOB.hostId);
  x.expire();
  await assert.rejects(x.integration.recoveryHandoff(handle),
    /MCP_JOB_CAPABILITY_REQUIRED/);
});
test('ABR-99 explicit ABR-17 coordinator yields one PR and review queue per head',async t=>{
  let published=0;
  let head=HEAD_A;
  const coordinator={
    async submit(req) {
      published++;
      assert.equal(req.issueId,JOB.issueId);
      assert.equal(req.branch,JOB.branch);
      assert.equal(req.sessionId,JOB.sessionId);
      assert.equal(req.hostId,JOB.hostId);
      return {verifiedReceiptFromFixture:true,number:261,headSha:head};
    },
  };
  const verifier=async(receipt,identity)=>{
    assert.equal(identity.jobKey,JOB.jobKey);
    assert.equal(receipt.verifiedReceiptFromFixture,true);
    return {status:'in_review',issueId:JOB.issueId,
      repository:JOB.repositoryId,branch:JOB.branch,number:261,
      headSha:receipt.headSha,checksPassed:true,
      url:'https://github.com/REVREBEL/linear-agents/pull/261'};
  };
  const x=await init(t,{coordinator,verifier});
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  const item={issueId:JOB.issueId,summary:'Code complete for review'};
  const first=await x.integration.submitWork(handle,item);
  assert.equal(first.reviewQueued,true);
  assert.equal(first.reviewCreated,true);
  assert.equal(first.reviewerAcknowledged,false);
  assert.equal(first.issueCompleted,false);
  const repeat=await x.integration.submitWork(handle,item);
  assert.equal(repeat.reviewCreated,false);
  assert.equal(repeat.reviewId,first.reviewId);
  assert.equal((await x.inbox.list()).length,1);
  // Different SHA => new review cycle, same PR number / no duplicate PR.
  head=HEAD_B;
  const next=await x.integration.submitWork(handle,item);
  assert.notEqual(next.reviewId,first.reviewId);
  assert.equal(next.prNumber,first.prNumber);
  assert.equal((await x.inbox.list()).length,2);
  assert.equal(published,3,'coordinator owns retry idempotency, never MCP');
  const claimed=await x.inbox.claim(next.reviewId,'chatgpt-review-harness');
  assert.equal(claimed.state,'claimed');
  await assert.rejects(x.inbox.finish(next.reviewId,{
    status:'reviewed',summary:'Done without verified publication',
  }),/Published GitHub review evidence required/);
  const reviewed=await x.inbox.finish(next.reviewId,{
    status:'reviewed',summary:'Human review published',
    delivery:{githubReviewId:42,githubReviewedCommit:HEAD_B,
      verifiedAt:new Date().toISOString()},
  });
  assert.equal(reviewed.state,'reviewed');
  assert.equal((await x.store.get(JOB.jobKey)).state,'running',
    'Reviewer ACK never closes coding job or marks Linear Done');
});
test('ABR-99 submission failure modes cannot claim reviewer notification',async t=>{
  const resultFactory=(change={})=>({status:'in_review',issueId:JOB.issueId,
    repository:JOB.repositoryId,branch:JOB.branch,
    number:262,headSha:HEAD_A,checksPassed:true,
    url:'https://github.com/REVREBEL/linear-agents/pull/262',...change});
  for (const fault of [
    {status:'blocked'}, {status:'done'}, {checksPassed:false},
    {branch:'feat/other'}, {headSha:'invalid'},
    {repository:'attacker/repo'}, {issueId:'ABR-OTHER'},
  ]) {
    await t.test(JSON.stringify(fault),async child=>{
      const x=await init(child,{
        coordinator:{submit:async()=>({id:'trusted-fixture'})},
        verifier:async()=>resultFactory(fault),
      });
      const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
      await assert.rejects(x.integration.submitWork(handle,{
        issueId:JOB.issueId,summary:'Forged completed work',
      }),/UNVERIFIED_SUBMISSION_OUTCOME/);
      assert.equal((await x.inbox.list()).length,0);
    });
  }
});
test('ABR-99 no review destination or disabled coordinator never publishes',async t=>{
  let calls=0;
  const x=await init(t,{
    coordinator:{submit:async()=>{calls++;return {headSha:HEAD_A};}},
    verifier:async()=>({
      status:'in_review',issueId:JOB.issueId,
      repository:JOB.repositoryId,branch:JOB.branch,number:262,
      headSha:HEAD_A,checksPassed:true,
      url:'https://github.com/REVREBEL/linear-agents/pull/262',
    }),
    config:{projects:{}},
  });
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  await assert.rejects(x.integration.submitWork(handle,{
    issueId:JOB.issueId,summary:'Should not notify',
  }),/REVIEW_DESTINATION_UNAVAILABLE/);
  assert.equal(calls,1);
  assert.equal((await x.inbox.list()).length,0);
});


test('ABR-99 D5 portable handoff requires canonical source verification and full envelope', async t=>{
  const envelope={
    handoffVersion:1, repository:JOB.repositoryId,
    repoCommit:'c'.repeat(40), contextSha256:'b'.repeat(64),
    handoffSha256:'d'.repeat(64), messageSha256:'e'.repeat(64),
    message:'Use pinned, complete README context before continuing',
    contextBundle:{gitHeadSha:'c'.repeat(40),documents:[
      {id:'repo.bridge',content:'Full README bytes from canonical D5 resolver'},
    ]},
  };
  const x=await init(t,{d5Verifier:async(value,scope)=>{
    assert.equal(scope.jobKey,JOB.jobKey);
    assert.equal(scope.sessionId,JOB.sessionId);
    assert.equal(scope.hostId,JOB.hostId);
    return value===envelope;
  }});
  const handle=await x.integration.bindAdmittedJob(x.issueAdmission());
  const verified=await x.integration.sourceLinkedHandoff(handle,envelope);
  assert.equal(verified.kind,'source-linked-context');
  assert.equal(verified.handoffSha256,envelope.handoffSha256);
  assert.equal(verified.envelope,envelope);
  assert.equal(verified.authority,'portable-readme-context-not-execution');
  await assert.rejects(x.integration.sourceLinkedHandoff(handle,{
    ...envelope,repository:'OTHER/repo',
  }),/INVALID_D5_CONTEXT_ENVELOPE/);
  await assert.rejects(x.integration.sourceLinkedHandoff(handle,{
    ...envelope,repoCommit:'e'.repeat(40),
  }),/INVALID_D5_CONTEXT_ENVELOPE/);
  await assert.rejects(x.integration.sourceLinkedHandoff(handle,{
    ...envelope,message:'Manipulated outside canonical verifier',
  }),/D5_SOURCE_VERIFICATION_REQUIRED/);
  const nonVerified=await init(t);
  const handle2=await nonVerified.integration.bindAdmittedJob(nonVerified.issueAdmission());
  await assert.rejects(nonVerified.integration.sourceLinkedHandoff(handle2,envelope),
    /CANONICAL_D5_VERIFIER_NOT_CONFIGURED/);
});
