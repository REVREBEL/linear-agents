import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {createSubmissionGithubBroker} from './submission-github-broker.mjs';

const repository='REVREBEL/linear-agents';
const scope={agentId:'chatgpt-review',repository,appId:'12345',installationId:'23456'};
const mapping={...scope,repositoryNumericId:'34567'};
const head='a'.repeat(40), base='b'.repeat(40), newer='c'.repeat(40);
const permissions={contents:'read',pull_requests:'read',checks:'read',
  statuses:'read',metadata:'read'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=privateKey.export({type:'pkcs8',format:'pem'});
const pinnedChecks=[{name:'CI',appId:'42'}];

function fixture({state='open',draft=false,ci='success',unresolved=0,
  outdated=0,paginated=false,wrongRepo=false,changeHead=false,reviewCount=1,
  badGraphql=false,fetchStatus=200,changesRequested=false,reviewEntries=null}={}){
  let prReads=0;
  const calls=[];
  const fetchImpl=async(input,options)=>{
    const url=new URL(input),path=url.pathname;
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers['X-GitHub-Api-Version'],'2022-11-28');
    const auth=options.headers.Authorization.slice(7);
    calls.push({path,method:options.method,query:url.search});
    if(path==='/app'||path.endsWith('/installation')||path.endsWith('/access_tokens')){
      const [a,b,c]=auth.split('.');
      assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),publicKey,Buffer.from(c,'base64url')));
      assert.equal(JSON.parse(Buffer.from(b,'base64url')).iss,scope.appId);
    } else { assert.equal(auth,'fixture-restricted-app-token-123456789012345'); }
    let data;
    let status=options.method==='POST'&&path!=='/graphql'?201:200;
    if(path==='/app')data={id:Number(scope.appId)};
    else if(path.endsWith('/installation'))data={
      id:Number(scope.installationId),app_id:Number(scope.appId),
      permissions,
    };
    else if(path.endsWith('/access_tokens')){
      assert.deepEqual(JSON.parse(options.body),{
        repository_ids:[Number(mapping.repositoryNumericId)],permissions});
      data={token:'fixture-restricted-app-token-123456789012345',
        expires_at:new Date(Date.now()+3600000).toISOString(),permissions,
        repositories:[{id:Number(mapping.repositoryNumericId),full_name:repository}]};
    }
    else if(path==='/repos/'+repository) data={
      id:Number(mapping.repositoryNumericId),full_name:repository,
      archived:false,disabled:false};
    else if(path==='/repos/'+repository+'/pulls/289'){
      prReads++;
      data={number:289,
        html_url:'https://github.com/'+repository+'/pull/289',
        state,draft,head:{sha:changeHead&&prReads===2?newer:head,
          repo:{full_name:wrongRepo?'foreign/fork':repository},ref:'feat/abr18'},
        base:{sha:base,repo:{full_name:repository},ref:'main'},
        user:{login:'coding-agent'}};
    }
    else if(path==='/repos/'+repository+'/commits/'+head+'/check-runs'){
      data={total_count:1,check_runs:[{
        name:'CI',app:{id:42},head_sha:head,
        status:ci==='pending'?'in_progress':'completed',
        conclusion:ci==='success'?'success':ci==='failed'?'failure':null,
      }]};
    }
    else if(path==='/repos/'+repository+'/pulls/289/reviews'){
      data=reviewEntries ?? Array.from({length:reviewCount},(_,i)=>({
        id:1+i,commit_id:head,state:changesRequested?'CHANGES_REQUESTED':'COMMENTED',
        submitted_at:'2026-11-24T13:00:00Z',user:{login:'reviewer'},
      }));
    }
    else if(path==='/graphql'){
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      assert.match(body.query,/ABR18VerifiedReviewThreads/);
      assert.deepEqual(body.variables,{owner:'REVREBEL',name:'linear-agents',number:289});
      data=badGraphql?{errors:[{message:'access denied'}]}:{
        data:{repository:{nameWithOwner:repository,pullRequest:{
          number:289,headRefOid:head,
          reviewThreads:{pageInfo:{hasNextPage:paginated},
            nodes:Array.from({length:unresolved+1},(_,i)=>({
              isResolved:i>=unresolved,isOutdated:i<outdated,
            }))},
        }}},
      };
    }else{throw Error('unexpected endpoint '+path);}
    if(fetchStatus!==200&&path==='/graphql')status=fetchStatus;
    return new Response(JSON.stringify(data),{status});
  };
  const broker=createSubmissionGithubBroker({
    mappings:[mapping],loadPrivateKey:async id=>{
      assert.equal(id,scope.appId);return pem;
    },allowObservation:true,fetchImpl,
  });
  return {broker,calls};
}

test('reviewer-only App facade reads pinned repo PR checks and threads, no tokens/dispatch',async()=>{
  const x=fixture();
  const a=await x.broker.forReviewScope(scope);
  assert.deepEqual(Object.keys(a).sort(),['mapping','observeReview']);
  assert.deepEqual(a.mapping,{repository,appId:scope.appId,installationId:scope.installationId});
  const event=await a.observeReview(289,pinnedChecks);
  assert.equal(event.source,'github-app-readonly');
  assert.equal(event.repository,repository);
  assert.equal(event.pullNumber,289);
  assert.equal(event.headSha,head);
  assert.equal(event.baseSha,base);
  assert.equal(event.ciStatus,'success');
  assert.equal(event.githubContextReady,true);
  assert.equal(event.unresolvedThreads,0);
  assert.equal(event.reviewCount,1);
  assert.equal(event.reviewLaunchStatus,'not_started');
  assert.equal(event.dispatchAuthorized,false);
  assert.equal(event.dispatched,false);
  assert.equal(JSON.stringify(event).includes('fixture-restricted-app-token'),false);
  assert.equal(x.calls.filter(c=>c.path.endsWith('/pulls/289')).length,2);
  assert.equal(x.calls.filter(c=>c.path==='/graphql').length,1);
  assert.equal(x.calls.some(c=>c.method==='POST'&&c.path!=='/graphql'&&
    !c.path.endsWith('/access_tokens')),false);
});

test('review evidence never authorizes dispatch for pending/failed CI or unresolved threads',async()=>{
  for(const options of [{ci:'pending'},{ci:'failed'},{unresolved:2},
      {changesRequested:true},{state:'closed'},{draft:true}]){
    const x=fixture(options);
    const evidence=await (await x.broker.forReviewScope(scope)).observeReview(289,pinnedChecks);
    assert.equal(evidence.githubContextReady,false,JSON.stringify(options));
    assert.equal(evidence.reviewLaunchStatus,'not_started');
    assert.equal(evidence.dispatched,false);
  }
});

test('out of-scope GitHub scopes and unpinned check specifications fail closed',async()=>{
  const x=fixture();
  await assert.rejects(x.broker.forReviewScope({...scope,agentId:'coding'}),/BROKER_DENIED/);
  await assert.rejects(x.broker.forReviewScope({...scope,repository:'other/repo'}),/BROKER_DENIED/);
  await assert.rejects(x.broker.forReviewScope({...scope,appId:'999'}),/BROKER_DENIED/);
  const facade=await x.broker.forReviewScope(scope);
  for(const checks of [[],[{name:'CI',appId:'42'},{name:'CI',appId:'42'}],
      [{name:'CI',appId:'wrong'}]]){
    await assert.rejects(facade.observeReview(289,checks),/BROKER_DENIED/);
  }
  await assert.rejects(facade.observeReview(-1,pinnedChecks),/BROKER_DENIED/);
  const publication=createSubmissionGithubBroker({
    mappings:[mapping],loadPrivateKey:async()=>pem,fetchImpl:async()=>{},
    allowPublication:true,allowObservation:true,
  });
  await assert.rejects(publication.forReviewScope(scope),/BROKER_DENIED/);
});

test('stale or ambiguous GitHub context does not become verified evidence',async()=>{
  for(const options of [{paginated:true},{wrongRepo:true},{changeHead:true},
    {badGraphql:true},{fetchStatus:403}]){
    const x=fixture(options);
    const facade=await x.broker.forReviewScope(scope);
    await assert.rejects(facade.observeReview(289,pinnedChecks),/BROKER_DENIED/,
      JSON.stringify(options));
  }
});

test('missing required check or ambiguous check identity defers rather than approving',async()=>{
  const x=fixture();
  const facade=await x.broker.forReviewScope(scope);
  const report=await facade.observeReview(289,[{name:'CI',appId:'43'}]);
  assert.equal(report.githubContextReady,false);
  assert.equal(report.ciStatus,'unknown');
  assert.equal(report.reviewLaunchStatus,'not_started');
});

test('existing coding scope facade keeps its read operations unchanged',async()=>{
  const x=fixture();
  const facade=await x.broker.forScope(scope);
  assert.deepEqual(Object.keys(facade).sort(),[
    'branchHead','checks','findOpenPull','getPull','mapping',
  ]);
  assert.equal(facade.observeReview,undefined);
});


test('an active change request survives later comments and new commits',async()=>{
  const request={id:1,commit_id:base,state:'CHANGES_REQUESTED',submitted_at:'2026-11-24T13:00:00Z',user:{login:'reviewer'}};
  const comment={id:2,commit_id:head,state:'COMMENTED',submitted_at:'2026-11-24T14:00:00Z',user:{login:'reviewer'}};
  for(const entries of [[request],[request,comment]]) {
    const x=fixture({reviewEntries:entries});
    const result=await (await x.broker.forReviewScope(scope)).observeReview(289,pinnedChecks);
    assert.equal(result.changesRequestedReviews,1);
    assert.equal(result.githubContextReady,false);
  }
  const approval={...comment,id:3,state:'APPROVED',submitted_at:'2026-11-24T15:00:00Z'};
  const x=fixture({reviewEntries:[request,comment,approval]});
  const result=await (await x.broker.forReviewScope(scope)).observeReview(289,pinnedChecks);
  assert.equal(result.changesRequestedReviews,0);
  assert.equal(result.githubContextReady,true);
});
