import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createSubmissionIngress} from '../bridge/orchestration/submission-ingress.mjs';
import {createManagedSubmissionRunner} from '../bridge/orchestration/managed-submission-runner.mjs';
import {createManagedProviderLauncher} from '../bridge/orchestration/managed-provider-launch.mjs';
import {createSubmissionCoordinator} from '../bridge/orchestration/submission-coordinator.mjs';
import {createMcpBridgeIntegration} from '../bridge/orchestration/mcp-milestone-integration.mjs';
import {createActiveTaskMemory} from '../memory/active-task-memory.mjs';
import {linearJobDuplicateResponse} from '../jobs/admission/job-admission.mjs';
import {preflightLinearJob} from '../jobs/admission/job-preflight.mjs';
import {coordinateLocalExecution} from '../bridge/orchestration/local-execution-coordinator.mjs';
import {setup,defaultScope,A,REPO,uuid} from './fixtures/submission-provider-fixture.mjs';

const cli=new URL('./submit-work.mjs',import.meta.url).pathname;
const providers=['antigravity','trae','chatgpt-cli'];
const argsFor=(mode,issue)=>mode==='none'?['-e','process.exit(0)']:
  mode==='wait'?['-e','setTimeout(()=>{},10000)']:
    [cli,...(['failed','blocked'].includes(mode)?['--'+mode]:[]),issue,'Fixture submission'];
async function fixture(t,agent,{mode='success',wrongIssue=false,lost=null}={}){
  const s={...defaultScope,agentId:agent,tenantId:uuid(3),jobKey:agent+':managed-fixture',
    appId:String(123+providers.indexOf(agent)),installationId:String(456+providers.indexOf(agent))};
  const x=await setup(t,{fixtureScope:s,lost});
  const {jobStore}=x;
  await jobStore.transition(s.jobKey,'queued',{workspace:s.repositoryRoot,expectedHeadSha:null});
  const proofs=new WeakMap();
  const ingress=createSubmissionIngress({jobStore,mappings:[x.mapping],enabled:true,
    verifyLauncher:e=>proofs.get(e),verifyRunner:(a,b)=>a===b});
  const coordinator=createSubmissionCoordinator({jobStore,outbox:x.outbox,enabled:true,
    verifyAdmission:ingress.verifyAdmission,isAdmissionLive:ingress.isAdmissionLive,
    adapters:x.adapters,verifyRecovery:x.verifyRecovery});
  const config=Object.fromEntries(providers.map(p=>[p,{binary:'/opt/fixture/'+p,
    commandPath:'/opt/agent-tools/bin/submit-work',python:'/usr/bin/python3',model:'openai/fixture',configPath:'/fixture/trae.yaml',
    env:{HOME:'/fixture/home',PATH:'/usr/bin:/bin'}}]));
  let child,launch;
  const launchProvider=createManagedProviderLauncher({providerConfigs:config,
    agyRunnerPath:'/opt/fixture/run_agent.py',
    isolatedSpawn:(spec,context)=>{
      launch=spec;
      assert.equal(context.agent,agent);
      assert.equal(spec.options.cwd,s.repositoryRoot);
      assert.deepEqual(Object.keys(spec.options.env).sort(),(agent==='antigravity'?
        ['HOME','PATH','BRIDGE_MANAGED_SUBMISSION','ANTIGRAVITY_BIN','ANTIGRAVITY_WORKSPACE','ANTIGRAVITY_MODE']:
        ['HOME','PATH','BRIDGE_MANAGED_SUBMISSION']).sort());
      assert.ok(!JSON.stringify(spec).includes('fixture-linear-oauth'));
      assert.ok(!JSON.stringify(spec).includes('fixture-worker-secret'));
      // Mock native harness. Execute the actual CLI with inherited FD 3.
      child=spawn(process.execPath,argsFor(mode,wrongIssue?'ABR-18':s.issueIdentifier),{
        cwd:x.root,env:spec.options.env,stdio:['pipe','pipe','pipe','pipe']});
      return child;
    }});
  const runner=createManagedSubmissionRunner({jobStore,ingress,coordinator,
    launchProofs:proofs,enabled:true,captureHead:async()=>A,
    resolvePlan:async()=>({agentId:agent,repository:REPO,repositoryRoot:s.repositoryRoot,
      issueUuid:s.issueUuid,branch:s.branch,base:s.base,appId:s.appId,installationId:s.installationId,
      jobKey:s.jobKey,tenantId:s.tenantId,sessionId:s.sessionId,workspace:s.repositoryRoot,projectId:"fixture",role:"coding",
      commandPath:config[agent].commandPath,expiresAt:Date.now()+30000}),launchProvider});
  const job={issueMetadata:{id:s.issueUuid,identifier:s.issueIdentifier},agentSessionId:s.sessionId,
    organizationId:s.tenantId,payload:{data:{promptContext:'Implement fixture'}}};
  const route={ok:true,executionHost:'bridge-server',repository:REPO,repositoryRoot:s.repositoryRoot,
    launchDirectory:s.repositoryRoot,projectId:'fixture',projectScope:'.'};
  const params={agent,job,route,jobKey:s.jobKey,workspace:s.repositoryRoot,filename:'/fixture/job.json',
    prompt:'Implement fixture'};
  return {...x,s,job,route,runner,params,getChild:()=>child,getLaunch:()=>launch};
}
test('M4 each managed native provider uses real private CLI and mapped M3 publication adapters',async t=>{
  for(const agent of providers)await t.test(agent,async t=>{
    const x=await fixture(t,agent);
    await x.runner.run(x.params);
    const row=await x.jobStore.get(x.s.jobKey);
    assert.equal(row.state,'completed');assert.equal(row.expectedHeadSha,A);
    assert.equal(row.submissionStage,'session_closed');
    assert.deepEqual(x.effects,['github','comment','state','worker']);
    assert.equal((await x.inbox.list()).length,1);
    assert.equal(row.githubAppId,x.s.appId);
    assert.equal(row.githubInstallationId,x.s.installationId);
    const spec=x.getLaunch();
    if(agent==='antigravity')assert.deepEqual(spec.args,['/opt/fixture/run_agent.py','--managed']);
    else if(agent==='trae')assert.deepEqual(spec.args.slice(0,-1),['run','--config-file','/fixture/trae.yaml','--working-dir',x.s.repositoryRoot,'--console-type','simple','--']);
    else assert.deepEqual(spec.args.slice(0,5),['run','--format','json','--model','openai/fixture']);
    if(agent!=='antigravity')assert.ok(spec.args.at(-1).includes('/opt/agent-tools/bin/submit-work ABR-17'));
  });
});
test('M4 explicit blocked/failed finishes close only failed session',async t=>{
  for(const mode of ['blocked','failed'])await t.test(mode,async t=>{
    const x=await fixture(t,'trae',{mode});await x.runner.run(x.params);
    const row=await x.jobStore.get(x.s.jobKey);
    assert.equal(row.state,'failed');assert.equal(row.submissionStage,mode);
    assert.deepEqual(x.effects,['worker']);assert.equal((await x.inbox.list()).length,0);
  });
});
test('M4 missing explicit finish, wrong issue and uncertain publication never mean completed',async t=>{
  for(const [options,expected] of [[{mode:'none'},[]],[{wrongIssue:true},[]],[{lost:'github'},['github']]]){
    await t.test(JSON.stringify(options),async t=>{
      const x=await fixture(t,'chatgpt-cli',options);await x.runner.run(x.params);
      const row=await x.jobStore.get(x.s.jobKey);
      assert.equal(row.state,'awaiting_external');assert.deepEqual(x.effects,expected);
      assert.equal((await x.inbox.list()).length,0);
    });
  }
});
test('M4 ABR-99 authenticated MCP uses exactly the same managed runner and outbox',async t=>{
  const x=await fixture(t,'antigravity',{mode:'wait'});
  const {completion}=await x.runner.dispatch(x.params);
  t.after(()=>x.getChild()?.kill());
  const memory=createActiveTaskMemory(x.root),evidence={};
  const grant={mode:'linear',role:'coding',agentId:x.s.agentId,tenantId:x.s.tenantId,
    repositoryId:REPO,repositoryRoot:x.s.repositoryRoot,issueId:x.s.issueUuid,
    sessionId:x.s.sessionId,jobKey:x.s.jobKey,hostId:'rebel-server',branch:x.s.branch,expiresAt:Date.now()+10000};
  const m=createMcpBridgeIntegration({jobStore:x.jobStore,memory,reviewInbox:x.inbox,
    verifyAdmittedJob:e=>e===evidence?grant:null,verifyToolReceipt:()=>null,
    submitAdmittedWork:x.runner.submitAdmittedWork});
  await assert.rejects(m.bindAdmittedJob({}),/UNVERIFIED_LINEAR_ADMISSION/);
  const handle=await m.bindAdmittedJob(evidence);
  await assert.rejects(m.submitWork(handle,{issueId:'ABR-18',summary:'wrong'}),/SUBMISSION_ISSUE_MISMATCH/);
  const result=await m.submitWork(handle,{issueId:x.s.issueUuid,summary:'Fixture submission'});
  assert.equal(result.stage,'session_closed');assert.deepEqual(x.effects,['github','comment','state','worker']);
  assert.equal((await x.inbox.list()).length,1);
  await assert.rejects(m.submitWork(handle,{issueId:x.s.issueUuid,summary:'Fixture submission'}),/JOB_LEDGER_SCOPE_MISMATCH/);
  x.getChild().kill();await completion;
  assert.equal((await x.jobStore.get(x.s.jobKey)).state,'completed');
});
test('M4 managed preflight never synchronizes workspace credentials or falls back to Mac',async()=>{
  for(const executionHost of ['bridge-server','macos']){
    const result=await preflightLinearJob({agent:'trae',job:{},managedSubmission:true,
      resolveJobRoute:async()=>({ok:true,executionHost}),
      syncLinearCredential:()=>{throw Error('secret export');},checkOpenCodeReady:async()=>{}});
    assert.equal(result.credential,null);
    assert.equal(Boolean(result.rejection),executionHost==='macos');
  }
});
test('M4 local execution selects managed dispatcher instead of any legacy provider callback',async t=>{
  for(const agent of providers)await t.test(agent,async t=>{
    const x=await fixture(t,agent);
    const result=await coordinateLocalExecution({job:x.job,route:x.route,agent,jobKey:x.s.jobKey,
      safeJobId:'fixture',host:'fixture',credential:{accessToken:'should-not-reach-child'},jobStore:x.jobStore,
      activeTaskMemory:createActiveTaskMemory(x.root),extractPromptContext:j=>j.payload.data.promptContext,
      logger:{log(){}},prepareTask:async()=>({workspace:x.params.workspace,filename:x.params.filename,routedJob:x.job}),
      managedSubmission:{dispatch:async args=>{const started=await x.runner.dispatch(args);x.completion=started.completion;return started;}},dispatchers:new Proxy({},{get(){throw Error('legacy dispatch');}})});
    assert.equal(result.status,202);
    // Wait for the actual durable finish/child closure, not for process exit alone.
    for(let n=0;n<100&&!(await x.jobStore.get(x.s.jobKey)).completionConfirmedAt;n++)await new Promise(r=>setTimeout(r,20));
    assert.equal((await x.jobStore.get(x.s.jobKey)).state,'completed');
    await x.completion;
    assert.deepEqual(x.effects,['github','comment','state','worker']);
  });
});

test('M4 unaccepted managed duplicate is retryable, accepted launch is acknowledged',()=>{
  const base={submissionMode:'managed',agent:'trae',state:'running'};
  assert.equal(linearJobDuplicateResponse({created:false,record:base},'job','fixture').status,503);
  assert.equal(linearJobDuplicateResponse({created:false,record:{...base,managedLaunchAcceptedAt:'2026-11-20T00:00:00Z'}},'job','fixture').status,202);
});
test('M4 concurrent managed launches for one checkout are denied before native spawn',async t=>{
  const x=await fixture(t,'trae',{mode:'wait'});
  const {completion}=await x.runner.dispatch(x.params);
  t.after(()=>x.getChild()?.kill());
  await assert.rejects(x.runner.dispatch({...x.params,jobKey:'other:delivery'}),/MANAGED_SUBMISSION_DENIED/);
  x.getChild().kill();await completion;
  assert.deepEqual(x.effects,[]);
});


test('M4 startup recovers only legacy quota waits, even when managed service is enabled',async()=>{
  const {isLegacyQuotaRetry}=await import('../bridge/orchestration/agy-quota-recovery.mjs');
  const {readFile}=await import('node:fs/promises');
  const resumeAt='2026-11-21T00:00:00Z';
  const records=[{key:'legacy',state:'waiting_quota',resumeAt},
    {key:'managed',state:'waiting_quota',resumeAt,submissionMode:'managed'},
    {key:'invalid',state:'waiting_quota',resumeAt:'not a date'}];
  assert.deepEqual(records.filter(isLegacyQuotaRetry).map(r=>r.key),['legacy']);
  const runtime=await readFile(new URL('../bridge/server/agent-bridge-runtime.mjs',import.meta.url),'utf8');
  assert.ok(runtime.includes('if (isLegacyQuotaRetry(record)) scheduleAgyResume(record.key, record.resumeAt);'));
  assert.ok(runtime.includes('if (!isLegacyQuotaRetry(record) || record.resumeAt !== resumeAt) return;'));
});
