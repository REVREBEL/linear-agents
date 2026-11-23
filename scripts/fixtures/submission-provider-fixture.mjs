import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createJobStore} from '../../jobs/persistence/job-store.mjs';
import {createSubmissionOutbox} from '../../jobs/persistence/submission-outbox.mjs';
import {createSubmissionCoordinator} from '../../bridge/orchestration/submission-coordinator.mjs';
import {submissionLedgerFields} from '../../bridge/orchestration/submission-ingress.mjs';
import {createSubmissionPublicationAdapters} from '../../bridge/orchestration/submission-publication.mjs';
import {createSubmissionGithubBroker} from '../../integrations/submission-github-broker.mjs';
import {createSubmissionLinearWorker} from '../../integrations/submission-linear-worker.mjs';
import {createReviewInbox} from '../../bridge/orchestration/review-inbox.mjs';

export const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const A='a'.repeat(40), B='b'.repeat(40), REPO='REVREBEL/linear-agents';
const APP='123', INSTALL='456', RID='789', BOT='555';
export const defaultScope={role:'coding',jobKey:'antigravity:fixture',sessionId:uuid(1),issueUuid:uuid(2),
  issueIdentifier:'ABR-17',tenantId:'tenant',agentId:'antigravity',hostId:'rebel-server',
  repository:REPO,repositoryRoot:'/fixture/repo',branch:'feat/abr-17',base:'main',
  appId:APP,installationId:INSTALL,cycle:'cycle1',headSha:A,expiresAt:2000000};
export const input={issueId:'ABR-17',summary:'Implemented fixture'};


const perms={contents:'read',pull_requests:'write',checks:'read',statuses:'read',metadata:'read'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const privatePEM=privateKey.export({format:'pem',type:'pkcs8'});
export async function setup(t,{mode='ready',lost=null,wrongActor=false,wrongAuthor=false,unverifiedSession=false,changeHeadBeforeComment=false,closedPrior=false,wrongSession=false,wrongActivity=false,noRoute=false,fixtureScope=null}={}){
  const scope=fixtureScope||defaultScope;
  const APP=scope.appId,INSTALL=scope.installationId;
  const mapping={agentId:scope.agentId,repository:REPO,appId:APP,installationId:INSTALL,repositoryNumericId:RID};
  const lm={agentId:scope.agentId,tenantId:scope.tenantId,organizationId:uuid(3),teamId:uuid(4),
    actorId:uuid(5),inReviewStateId:uuid(6),allowedSourceStateIds:[uuid(7)],
    workerUrl:'https://linear-'+scope.agentId+'.revrebel.io/complete'};
  const root=await mkdtemp(path.join(os.tmpdir(),'abr17-m3-'));
  const jobStore=createJobStore(root),inbox=createReviewInbox(root);
  const outboxes=[],effects=[],comments=[],sessions=new Map(),activityBySession=new Map();
  let pr=closedPrior?{number:41,html_url:'https://github.com/'+REPO+'/pull/41',state:'closed',draft:false,
    head:{repo:{full_name:REPO},ref:scope.branch,sha:A},base:{repo:{full_name:REPO},ref:'main'},
    user:{id:Number(BOT)},body:'existing closed PR'}:null,state={id:uuid(7),name:'In Progress',type:'started'},head=A,gitReady=true;
  const admissions=new WeakMap(),recovery={};
  t.after(async()=>{for(const db of outboxes)db.close();await rm(root,{recursive:true,force:true});});
  const record=async(s=scope)=>{
    await jobStore.claim(s.jobKey,submissionLedgerFields(s));
    await jobStore.transition(s.jobKey,'running');
  };await record();
  const issue=()=>({id:scope.issueUuid,identifier:scope.issueIdentifier,archivedAt:null,team:{id:lm.teamId},state});
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
  const effect=name=>{effects.push(name);if(lost===name){lost=null;throw Error('lost response');}};
  const fetchImpl=async(url,opt)=>{
    const u=new URL(url),token=opt.headers.Authorization.slice(7);
    const payload=opt.body&&JSON.parse(opt.body);
    assert.equal(opt.redirect,'error');
    if(u.hostname==='api.github.com'){
      const p=u.pathname;
      if(p==='/app'||p.endsWith('/installation')||p.endsWith('/access_tokens')){
        const [a,b,c]=token.split('.');
        assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),publicKey,Buffer.from(c,'base64url')));
      }
      if(p==='/app')return response({id:Number(APP)});
      if(p.endsWith('/installation'))return response({id:Number(INSTALL),app_id:Number(APP),permissions:perms});
      if(p.endsWith('/access_tokens')){
        assert.deepEqual(payload,{repository_ids:[Number(RID)],permissions:perms});
        return response({token:'fixture-installation-token-abcdef',expires_at:new Date(Date.now()+3600000).toISOString(),
          permissions:perms,repositories:[{id:Number(RID),full_name:REPO}]},201);
      }
      assert.equal(token,'fixture-installation-token-abcdef');
      if(p==='/repos/'+REPO)return response({id:Number(RID),full_name:REPO});
      if(p==='/repos/'+REPO+'/pulls'&&opt.method==='GET'){
        assert.equal(u.searchParams.get('state'),'all');return response(pr?[pr]:[]);
      }
      if(p==='/repos/'+REPO+'/pulls'&&opt.method==='POST'){
        assert.equal(pr,null);assert.equal(payload.head,scope.branch);assert.equal(payload.base,'main');
        pr={number:42,html_url:'https://github.com/'+REPO+'/pull/42',state:'open',draft:payload.draft,
          head:{repo:{full_name:REPO},ref:scope.branch,sha:head},base:{repo:{full_name:REPO},ref:'main'},
          user:{id:wrongAuthor?999:Number(BOT)},body:payload.body};effect('github');return response(pr,201);
      }
      if(p==='/repos/'+REPO+'/pulls/42')return response(pr);
      throw Error('unexpected github request');
    }
    if(u.hostname==='api.linear.app'){
      assert.equal(token,'fixture-linear-oauth-abcdef');
      const q=payload.query,v=payload.variables;
      if(q.includes('SubmissionSession')){
        const activity=activityBySession.get(v.id);
        const session={id:v.id,appUser:{id:wrongSession?uuid(99):lm.actorId},issue:{id:scope.issueUuid},
          archivedAt:null,status:activity&&!unverifiedSession?(activity.content.__typename==='AgentActivityResponseContent'?'complete':'error'):'active',
          activities:{nodes:activity?[activity]:[],pageInfo:{hasNextPage:false}}};
        return response({data:{agentSession:session}});
      }
      if(q.includes('SubmissionIdentity'))return response({data:{viewer:{id:wrongActor?uuid(99):lm.actorId},organization:{id:lm.organizationId}}});
      if(q.includes('SubmissionComments')){
        if(changeHeadBeforeComment)gitReady=false;
        return response({data:{issue:{id:scope.issueUuid,
          comments:{nodes:comments,pageInfo:{hasNextPage:false}}}}});
      }
      if(q.includes('SubmissionIssue'))return response({data:{issue:issue()}});
      if(q.includes('SubmissionTarget'))return response({data:{workflowState:{id:lm.inReviewStateId,name:'In Review',type:'started',team:{id:lm.teamId}}}});
      if(q.includes('mutation SubmissionComment')){
        assert.equal(v.input.issueId,scope.issueUuid);
        const comment={id:uuid(10+comments.length),body:v.input.body,user:{id:lm.actorId}};
        comments.push(comment);effect('comment');return response({data:{commentCreate:{success:true,comment:{id:comment.id}}}});
      }
      if(q.includes('mutation SubmissionState')){
        assert.equal(v.id,scope.issueUuid);assert.equal(v.input.stateId,lm.inReviewStateId);
        state={id:lm.inReviewStateId,name:'In Review',type:'started'};effect('state');
        return response({data:{issueUpdate:{success:true,issue:{id:scope.issueUuid}}}});
      }
      throw Error('unknown linear query');
    }
    if(url===lm.workerUrl){
      assert.equal(token,'fixture-worker-secret-abcdef');
      assert.ok(['completed','failed'].includes(payload.status));assert.equal(payload.organizationId,lm.organizationId);
      const operationId=payload.body.match(/\[bridge-submission:([a-f0-9]{64})\]/)[1];
      sessions.set(operationId,{sessionId:payload.agentSessionId,organizationId:lm.organizationId,
        actorId:lm.actorId,operationId,status:payload.status,terminal:!unverifiedSession});
      activityBySession.set(payload.agentSessionId,{id:uuid(80+sessions.size),
        createdAt:new Date().toISOString(),archivedAt:null,ephemeral:false,signal:null,
        user:{id:wrongActivity?uuid(99):lm.actorId},
        content:{__typename:payload.status==='completed'?'AgentActivityResponseContent':'AgentActivityErrorContent',body:payload.body}});
      effect('worker');
      return response({ok:true,agentSessionId:payload.agentSessionId,organizationId:lm.organizationId,activityType:payload.activityType});
    }
    throw Error('unexpected host');
  };
  const broker=createSubmissionGithubBroker({mappings:[mapping],allowPublication:true,
    loadPrivateKey:async()=>privatePEM,fetchImpl});
  const linearWorker=createSubmissionLinearWorker({mappings:[lm],fetchImpl,
    loadLinearToken:async()=> 'fixture-linear-oauth-abcdef',loadWorkerSecret:async()=> 'fixture-worker-secret-abcdef'});
  const routing={projects:{fixture:{repository:REPO,codeReview:{provider:'chatgpt',conversationMode:'reuse-existing',
    autoSend:true,conversationUrl:'https://chatgpt.com/g/g-p-fixture/c/fixture'}}}};
  const gitPreflight={inspectGit:async({scope:s})=>{
    if(!gitReady||s.headSha!==head)throw Error('GIT_CHANGED');
    return {verified:true,repository:s.repository,repositoryRoot:s.repositoryRoot,branch:s.branch,base:s.base,
      headSha:head,remoteHeadSha:head,clean:true,detached:false,conflicts:false,checksPassed:true,
      installationId:INSTALL,appId:APP};}};
  const {adapters,verifyRecovery}=createSubmissionPublicationAdapters({gitPreflight,githubBroker:broker,
    linearWorker,reviewInbox:inbox,reviewRoutingConfig:noRoute?{projects:{}}:routing,
    publicationPolicies:[{repository:REPO,agentId:scope.agentId,botUserId:BOT,mode}],
    verifyRecoveryRequest:async e=>e===recovery});
  function connect(){
    const outbox=createSubmissionOutbox(root);outboxes.push(outbox);
    return {outbox,coordinator:createSubmissionCoordinator({jobStore,outbox,enabled:true,
      now:()=>1990000,verifyAdmission:e=>admissions.get(e),adapters,verifyRecovery})};
  }
  const admit=async(c,s=scope)=>{const proof={};admissions.set(proof,s);return c.bind(proof);};
  const connection=connect(),handle=await admit(connection.coordinator);
  return {root,jobStore,inbox,comments,effects,connect,admit,record,recovery,handle,adapters,verifyRecovery,mapping,...connection,
    ready:()=>{pr.draft=false;},newHead:()=>{head=B;pr.head.sha=B;state={id:uuid(7),name:'In Progress',type:'started'};},
    changeGit:()=>{gitReady=false;},getPr:()=>pr};
}
