import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventIntelligenceEnricher,reconcileReviewProgress} from './event-intelligence-enrichment.mjs';

const org='dcedfdda-3793-4c5f-aa63-703897e9618b';
const repo='REVREBEL/linear-agents';
const head='a'.repeat(40),base='b'.repeat(40);
const checks=[{name:'CI',appId:'42'}];
const scope={
  agentId:'chatgpt-review',organizationId:org,repository:repo,
  appId:'12345',installationId:'23456',requiredChecks:checks,
};
const receipt=(overrides={})=>({
  schemaVersion:2,state:'durable_intake',durable:true,
  provider:'linear',workerIdentity:'linear-chatgpt-agent',
  deliveryId:'event:'+'a'.repeat(64),signedPayloadSha256:'a'.repeat(64),
  deliveryHash:'d'.repeat(64),organizationId:org,
  issueId:'1f982fb0-d74b-46d2-b7c9-d6d94e723937',
  verifiedIssue:{
    id:'1f982fb0-d74b-46d2-b7c9-d6d94e723937',
    organizationId:org,identifier:'ABR-18',
  },
  providerFactsVerifiedBy:'linear-oauth-app',
  prCandidate:{repository:repo,number:291},
  dispatchStatus:'not_started',reviewLaunchStatus:'not_started',dispatched:false,
  ...overrides,
});
const evidence=(patch={})=>({
  schemaVersion:1,source:'github-app-readonly',repository:repo,
  installationId:'23456',pullNumber:291,headSha:head,baseSha:base,
  observedAt:'2026-11-24T14:00:00Z',ciStatus:'success',
  githubContextReady:true,unresolvedThreads:0,changesRequestedReviews:0,
  reviewLaunchStatus:'not_started',dispatchAuthorized:false,dispatched:false,
  ...patch,
});
function fixture(ev=evidence()){
  const calls=[];
  const githubBroker={forReviewScope:async s=>{
    calls.push({method:'scope',scope:s});
    return {observeReview:async(n,c)=>{
      calls.push({method:'observe',number:n,requiredChecks:c});
      return ev;
    }};
  }};
  return {service:createEventIntelligenceEnricher({
    githubBroker,approvedScopes:[scope],
  }),calls};
}

test('durably admitted signed issue and pinned read-only GitHub context stay advisory',async()=>{
  const x=fixture();
  const out=await x.service.enrich(receipt());
  assert.equal(out.source,'github-app-readonly');
  assert.equal(out.githubContextReady,true);
  assert.equal(out.linkedIssueVerified,false);
  assert.equal(out.outcome,'defer');
  assert.equal(out.dispatchAuthorized,false);
  assert.equal(out.reviewLaunchStatus,'not_started');
  assert.equal(out.dispatched,false);
  assert.match(out.evidenceKey,/^[a-f0-9]{64}$/);
  assert.deepEqual(x.calls[0].scope,{
    agentId:'chatgpt-review',repository:repo,
    appId:'12345',installationId:'23456',
  });
  assert.deepEqual(x.calls[1],{method:'observe',number:291,requiredChecks:checks});
  assert.equal(JSON.stringify(out).includes('body'),false);
});

test('foreign orgs/repositories, fake receipt and fake GitHub proof fail closed',async()=>{
  const x=fixture();
  for(const input of [
    receipt({organizationId:'foreign-workspace'}),
    receipt({prCandidate:{repository:'FOREIGN/repo',number:291}}),
    receipt({state:'pending'}),
    receipt({durable:false}),
    receipt({workerIdentity:'coding'}),
    receipt({verifiedIssue:{id:'wrong',organizationId:org}}),
    receipt({providerFactsVerifiedBy:'none'}),
    receipt({dispatchStatus:'launched'}),
    receipt({dispatched:true}),
  ]){
    await assert.rejects(x.service.enrich(input),/EVIDENCE_DENIED/);
  }
  for(const bad of [
    evidence({repository:'FOREIGN/repo'}),
    evidence({headSha:'invalid'}),
    evidence({dispatchAuthorized:true}),
    evidence({reviewLaunchStatus:'launched'}),
    evidence({dispatched:true}),
  ]){
    await assert.rejects(fixture(bad).service.enrich(receipt()),/EVIDENCE_DENIED/);
  }
});

test('review handoff attempted is not agent launch, claimed is not review',async()=>{
  const record={reviewId:'e'.repeat(64),role:'chatgpt-user-review',
    repository:repo,number:291,headSha:head,state:'pending'};
  const cfg={githubEvidence:evidence()};
  assert.equal((await reconcileReviewProgress(record,cfg)).reviewLaunchStatus,'not_started');
  assert.equal((await reconcileReviewProgress({
    ...record,messageHandoff:{state:'attempted'},
  },cfg)).reviewLaunchStatus,'handoff-attempted-unverified');
  assert.equal((await reconcileReviewProgress({
    ...record,state:'claimed',
  },cfg)).reviewLaunchStatus,'claimed-unverified');
  assert.equal((await reconcileReviewProgress({
    ...record,state:'blocked',
  },cfg)).reviewLaunchStatus,'blocked');
  await assert.rejects(reconcileReviewProgress(record,{
    githubEvidence:evidence({headSha:base}),
  }),/EVIDENCE_DENIED/);
});

test('published GitHub review gets verified only through fresh trusted readback',async()=>{
  const record={reviewId:'e'.repeat(64),role:'chatgpt-user-review',
    repository:repo,number:291,headSha:head,state:'reviewed',
    messageHandoff:{state:'attempted'},delivery:{
      githubReviewId:9821,githubReviewedCommit:head,verifiedAt:'2026-11-24T15:00:00Z',
    }};
  const cfg={githubEvidence:evidence()};
  await assert.rejects(reconcileReviewProgress(record,cfg),/EVIDENCE_DENIED/);
  await assert.rejects(reconcileReviewProgress(record,{
    ...cfg,verifyPublishedReview:async()=>({githubReviewId:9821,
      githubReviewedCommit:base,verifiedAt:'2026-11-24T15:01:00Z'}),
  }),/EVIDENCE_DENIED/);
  let calls=0;
  const result=await reconcileReviewProgress(record,{
    ...cfg,verifyPublishedReview:async(t,delivery)=>{
      calls++;
      assert.equal(t.reviewId,record.reviewId);
      assert.equal(delivery.githubReviewId,9821);
      return {githubReviewId:9821,githubReviewedCommit:head,
        verifiedAt:'2026-11-24T15:01:00Z'};
    },
  });
  assert.equal(calls,1);
  assert.equal(result.reviewLaunchStatus,'published-review-verified');
  assert.equal(result.dispatchAuthorized,false);
  assert.equal(result.githubReviewId,9821);
});

test('scope configuration rejects unpinned and duplicate reviewer mappings',()=>{
  const broker={forReviewScope:async()=>({})};
  for(const approvedScopes of [
    [],[{...scope,agentId:'coding'}],[{...scope,repository:'../escape'}],
    [{...scope,requiredChecks:[]}],[scope,scope],
  ])assert.throws(()=>createEventIntelligenceEnricher({
    githubBroker:broker,approvedScopes,
  }),/EVIDENCE_DENIED/);
});
