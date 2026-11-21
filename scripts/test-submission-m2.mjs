import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createSubmissionIngress, submissionLedgerFields } from '../bridge/orchestration/submission-ingress.mjs';
import { createSubmissionGithubBroker } from '../integrations/submission-github-broker.mjs';
import { createSubmissionGitPreflight } from '../bridge/orchestration/submission-git-preflight.mjs';
import { serveSubmissionChannel } from '../bridge/handlers/submission-channel.mjs';
import { createJobStore } from '../jobs/persistence/job-store.mjs';
import { createSubmissionOutbox } from '../jobs/persistence/submission-outbox.mjs';
import { createSubmissionCoordinator } from '../bridge/orchestration/submission-coordinator.mjs';

const HEAD='a'.repeat(40), BASE='b'.repeat(40);
const MAP={agentId:'antigravity',repository:'REVREBEL/linear-agents',appId:'12345',installationId:'23456',repositoryNumericId:'34567'};
const SCOPE={role:'coding',jobKey:'antigravity:fixture',sessionId:'session',issueUuid:'d6447556-9387-4bcf-b9b4-4ac160aa1939',
  issueIdentifier:'ABR-17',tenantId:'tenant',agentId:MAP.agentId,hostId:'rebel-server',repository:MAP.repository,
  repositoryRoot:'/fixture/repo',branch:'feat/abr-17',base:'main',appId:MAP.appId,installationId:MAP.installationId,cycle:'cycle1',headSha:HEAD};
const INPUT={issueId:'ABR-17',summary:'Fixture complete'};
async function local(t, overrides={}){
  const root=await mkdtemp(path.join(tmpdir(),'abr17-m2-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createJobStore(root);
  await store.claim(SCOPE.jobKey,submissionLedgerFields(SCOPE));
  await store.transition(SCOPE.jobKey,'running');
  const launcher={}, runner={}, wrong={};let time=10000;
  const ingress=createSubmissionIngress({jobStore:store,mappings:[MAP],enabled:true,ttlMs:2000,
    now:()=>time,verifyLauncher:e=>e===launcher?{scope:SCOPE,runnerIdentity:runner,expiresAt:20000}:null,
    verifyRunner:async(e,expected)=>e===expected,...overrides});
  const cap=await ingress.issue(launcher);
  return {ingress,store,launcher,runner,wrong,cap,root,expire:()=>{time=13000;}};
}
test('M2 capability scopes launcher, runner and canonical ledger; replay issuance and wrong identity denied',async t=>{
  const x=await local(t);
  await assert.rejects(x.ingress.issue({}),/INVALID_TRUSTED_LAUNCH_SCOPE/);
  await assert.rejects(x.ingress.issue(x.launcher),/ALREADY_ISSUED/);
  await assert.rejects(x.ingress.authenticate(x.cap.token,x.wrong),/DENIED/);
  await assert.rejects(x.ingress.authenticate('not-a-token',x.runner),/DENIED/);
  const p=await x.ingress.authenticate(x.cap.token,x.runner);
  assert.equal(x.ingress.verifyAdmission(p).jobKey,SCOPE.jobKey);
  assert.equal(x.ingress.isAdmissionLive(p),true);
  x.cap.revoke();
  assert.equal(x.ingress.isAdmissionLive(p),false);
  await assert.rejects(x.ingress.authenticate(x.cap.token,x.runner),/DENIED/);
});
test('M2 capability expiration and changed ledger fail closed',async t=>{
  const x=await local(t);
  await x.store.transition(SCOPE.jobKey,'running',{expectedHeadSha:BASE});
  await assert.rejects(x.ingress.authenticate(x.cap.token,x.runner),/SCOPE_MISMATCH/);
  await x.store.transition(SCOPE.jobKey,'running',{expectedHeadSha:HEAD});
  const proof=await x.ingress.authenticate(x.cap.token,x.runner);
  x.expire();
  assert.equal(x.ingress.isAdmissionLive(proof),false);
  await assert.rejects(x.ingress.authenticate(x.cap.token,x.runner),/DENIED/);
});
test('M2 ingress revocation propagates through M1 during an in-flight submission',async t=>{
  const x=await local(t);
  const outbox=createSubmissionOutbox(x.root);
  t.after(()=>outbox.close());
  let release,entered;
  const wait=new Promise(r=>{release=r;}), ready=new Promise(r=>{entered=r;});
  const calls=[];
  const coordinator=createSubmissionCoordinator({jobStore:x.store,outbox,enabled:true,now:()=>10000,
    verifyAdmission:x.ingress.verifyAdmission,isAdmissionLive:x.ingress.isAdmissionLive,
    adapters:{
      inspectGit:async()=>{calls.push('inspect');entered();await wait;return {verified:true,
        repository:SCOPE.repository,repositoryRoot:SCOPE.repositoryRoot,branch:SCOPE.branch,base:SCOPE.base,
        headSha:HEAD,remoteHeadSha:HEAD,clean:true,detached:false,conflicts:false,checksPassed:true,
        installationId:MAP.installationId,appId:MAP.appId};},
      ...Object.fromEntries(['publishGitHub','postLinear','moveInReview','queueReview','closeSession'].map(k=>[k,async()=>{calls.push(k);throw Error('Unexpected');}]))
    }});
  const work=x.ingress.submitLocal({token:x.cap.token,runnerEvidence:x.runner,input:INPUT},coordinator);
  await ready;x.cap.revoke();release();
  await assert.rejects(work,/SUBMISSION_CAPABILITY_REQUIRED/);
  assert.deepEqual(calls,['inspect']);
});
test('M2 private Unix IPC transports only issue and summary and rejects extra fields',async t=>{
  const x=await local(t);
  const socketPath=path.join(x.root,'private.sock');
  let calls=0;
  const coordinator={
    async bind(proof){assert.equal(x.ingress.verifyAdmission(proof).jobKey,SCOPE.jobKey);return {};},
    async submit(_,input){calls++;assert.deepEqual(input,INPUT);return {stage:'received'};},revoke(){}
  };
  const server=net.createServer(socket=>serveSubmissionChannel(socket,{ingress:x.ingress,coordinator,
    token:x.cap.token,runnerEvidence:x.runner}));
  server.listen(socketPath);await once(server,'listening');
  t.after(()=>new Promise(r=>server.close(r)));
  async function send(body){
    const socket=net.createConnection(socketPath);await once(socket,'connect');
    socket.write(body);let output='';
    for await(const chunk of socket)output+=chunk.toString();
    return JSON.parse(output);
  }
  assert.deepEqual(await send(JSON.stringify(INPUT)+'\n'),{ok:true,result:{stage:'received'}});
  assert.equal((await send(JSON.stringify({...INPUT,headSha:BASE})+'\n')).ok,false);
  assert.equal((await send('{"issueId":"ABR-17"}\n{}\n')).ok,false);
  assert.equal(calls,1);
});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const PEM=privateKey.export({type:'pkcs8',format:'pem'});
const PERMS={contents:'read',pull_requests:'read',checks:'read',statuses:'read',metadata:'read'};
function brokerFixture(transform=(p,d)=>d){
  let now=Date.now(),minted=0;
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    const p=new URL(url).pathname,auth=opts.headers.Authorization.slice(7);
    assert.equal(new URL(url).origin,'https://api.github.com');
    assert.equal(opts.redirect,'error');
    calls.push(p);
    if(p==='/app'||p.endsWith('/installation')||p.endsWith('/access_tokens')){
      const [a,b,c]=auth.split('.');
      assert.ok(verify('RSA-SHA256',Buffer.from(a+'.'+b),publicKey,Buffer.from(c,'base64url')));
      assert.equal(JSON.parse(Buffer.from(b,'base64url')).iss,MAP.appId);
    }
    let data;
    if(p==='/app')data={id:Number(MAP.appId)};
    else if(p.endsWith('/installation'))data={id:Number(MAP.installationId),app_id:Number(MAP.appId),permissions:PERMS};
    else if(p.endsWith('/access_tokens')){
      minted++;assert.deepEqual(JSON.parse(opts.body),{repository_ids:[Number(MAP.repositoryNumericId)],permissions:PERMS});
      data={token:'fixture-token-0123456789-'+minted,expires_at:new Date(now+3600000).toISOString(),
        permissions:PERMS,repositories:[{id:Number(MAP.repositoryNumericId),full_name:MAP.repository}]};
    }else{
      assert.match(auth,/^fixture-token-/);
      if(p.includes('/git/ref/heads/'))data={ref:'refs/heads/'+p.split('/git/ref/heads/')[1],object:{type:'commit',sha:HEAD}};
      else if(p.includes('/check-runs'))data={total_count:1,check_runs:[{name:'ci',app:{id:42},head_sha:HEAD,status:'completed',conclusion:'success'}]};
      else data={id:Number(MAP.repositoryNumericId),full_name:MAP.repository};
    }
    return new Response(JSON.stringify(transform(p,data)),{status:opts.method==='POST'?201:200});
  };
  const broker=createSubmissionGithubBroker({mappings:[MAP],loadPrivateKey:async id=>{assert.equal(id,MAP.appId);return PEM;},fetchImpl,now:()=>now});
  return {broker,calls,minted:()=>minted,expire:()=>{now+=3600000;}};
}
test('M2 broker verifies app and exact installation, narrows token and refreshes without exporting secrets',async()=>{
  const x=brokerFixture();
  const [a,b]=await Promise.all([x.broker.forScope(SCOPE),x.broker.forScope(SCOPE)]);
  assert.equal(x.minted(),1);
  assert.deepEqual(Object.keys(a).sort(),['branchHead','checks','mapping']);
  assert.equal(await a.branchHead(SCOPE.branch),HEAD);
  assert.equal(await b.checks(HEAD,[{name:'ci',appId:'42'}]),true);
  assert.equal(await b.checks(HEAD,[{name:'ci',appId:'43'}]),false);
  x.expire();await a.branchHead(SCOPE.branch);assert.equal(x.minted(),2);
  await assert.rejects(x.broker.forScope({...SCOPE,installationId:'999'}),/BROKER_DENIED/);
  await assert.rejects(a.branchHead('../bad'),/BROKER_DENIED/);
});
test('M2 broker denies wrong app, installation, permission, expanded token, repository or checks',async t=>{
  for(const [label,change] of [
    ['wrong app',(p,d)=>p==='/app'?{id:999}:d],
    ['wrong installation',(p,d)=>p.endsWith('/installation')?{...d,id:999}:d],
    ['missing permission',(p,d)=>p.endsWith('/installation')?{...d,permissions:{contents:'read'}}:d],
    ['extra repo',(p,d)=>p.endsWith('/access_tokens')?{...d,repositories:[...d.repositories,{id:999,full_name:'BAD/repo'}]}:d],
    ['write scope',(p,d)=>p.endsWith('/access_tokens')?{...d,permissions:{...PERMS,contents:'write'}}:d],
    ['wrong repo',(p,d)=>p==='/repos/'+MAP.repository?{...d,id:999}:d],
  ])await t.test(label,async()=>{const x=brokerFixture(change);await assert.rejects(x.broker.forScope(SCOPE),/BROKER_DENIED/);});
  const x=brokerFixture((p,d)=>p.includes('/check-runs')?{...d,total_count:2}:d);
  const facade=await x.broker.forScope(SCOPE);
  await assert.rejects(facade.checks(HEAD,[{name:'ci',appId:'42'}]),/BROKER_DENIED/);
});
test('M2 real confined Git preflight checks clean branch, exact remote head, CI and conflicts',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'abr17-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo');await mkdir(repo);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:['ignore','pipe','pipe']}).toString().trim();
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  await writeFile(path.join(repo,'file.txt'),'base\n');git('add','.');git('commit','-qm','initial');
  const base=git('rev-parse','HEAD');git('checkout','-qb',SCOPE.branch);
  await writeFile(path.join(repo,'file.txt'),'new\n');git('add','.');git('commit','-qm','change');
  git('remote','add','origin','https://github.com/'+MAP.repository+'.git');
  const head=git('rev-parse','HEAD'),scope={...SCOPE,repositoryRoot:repo,headSha:head};
  let checks=true,remote=head;
  const githubBroker={forScope:async()=>({mapping:MAP,branchHead:async b=>b==='main'?base:remote,
    checks:async(sha,required)=>{assert.equal(sha,head);assert.deepEqual(required,[{name:'ci',appId:'42'}]);return checks;}})};
  const service=createSubmissionGitPreflight({projectsRoot:root,workspaces:[{root:repo,repository:MAP.repository,
    requiredChecks:[{name:'ci',appId:'42'}]}],githubBroker,expectedUid:process.getuid(),allowRootForIsolatedTests:true});
  const result=await service.inspectGit({scope});
  assert.equal(result.headSha,head);assert.equal(result.checksPassed,true);
  checks=false;await assert.rejects(service.inspectGit({scope}),/PREFLIGHT_DENIED/);checks=true;
  remote=base;await assert.rejects(service.inspectGit({scope}),/PREFLIGHT_DENIED/);remote=head;
  await writeFile(path.join(repo,'untracked'),'no');await assert.rejects(service.inspectGit({scope}),/PREFLIGHT_DENIED/);
  await rm(path.join(repo,'untracked'));
  await writeFile(path.join(repo,'.git','MERGE_HEAD'),base+'\n');await assert.rejects(service.inspectGit({scope}),/PREFLIGHT_DENIED/);
  await rm(path.join(repo,'.git','MERGE_HEAD'));
  git('checkout','--detach',head);await assert.rejects(service.inspectGit({scope}),/PREFLIGHT_DENIED/);
});


test('M2 actual submit-work CLI inherits private FD without credentials in arguments or environment',async t=>{
  const x=await local(t);
  const coordinator={
    async bind(proof){assert.equal(x.ingress.verifyAdmission(proof).jobKey,SCOPE.jobKey);return {};},
    async submit(_,input){assert.deepEqual(input,INPUT);return {stage:'received'};},revoke(){},
  };
  const child=spawn(process.execPath,[new URL('./submit-work.mjs',import.meta.url).pathname,
    INPUT.issueId,INPUT.summary],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe','pipe']});
  const closed=once(child,'close');
  serveSubmissionChannel(child.stdio[3],{ingress:x.ingress,coordinator,token:x.cap.token,runnerEvidence:x.runner});
  let stdout='',stderr='';
  child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});
  const [status]=await closed;
  assert.equal(status,0,stderr);
  assert.deepEqual(JSON.parse(stdout),{stage:'received'});
  assert.ok(!stdout.includes(x.cap.token));
  const denied=spawn(process.execPath,[new URL('./submit-work.mjs',import.meta.url).pathname,
    INPUT.issueId,INPUT.summary],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
  const [failed]=await once(denied,'close');
  assert.notEqual(failed,0);
});
