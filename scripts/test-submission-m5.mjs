import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat,writeFile,copyFile,open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {serveSubmissionChannel} from '../bridge/handlers/submission-channel.mjs';
import {acquireSubmissionLease} from '../jobs/persistence/submission-exclusive-lease.mjs';
import {createSubmissionCoordinator} from '../bridge/orchestration/submission-coordinator.mjs';
import {setup,defaultScope,input} from './fixtures/submission-provider-fixture.mjs';

function offline(x, overrides={}){
  const lease=acquireSubmissionLease(x.root);
  const coordinator=createSubmissionCoordinator({
    jobStore:x.jobStore,outbox:x.outbox,enabled:true,verifyAdmission:()=>null,
    adapters:Object.fromEntries(Object.keys(x.adapters).map(k=>[k,()=>{throw Error('OPERATOR_MUTATION_FORBIDDEN');}])),
    verifyRecovery:x.verifyRecovery,
    operatorRecovery:{verify:async (proof,approval)=>{
      assert.equal(approval.jobKey,defaultScope.jobKey);
      assert.equal(approval.headSha,defaultScope.headSha);
      return proof===x.recovery;
    },assertExclusive:lease.isHeld,assertQuiescent:()=>true,...overrides}
  });
  return {coordinator,lease};
}
test('M5 offline recovery observes each interrupted external effect without replay or advancing next effect',async t=>{
  for(const [lost,stage,state] of [
    ['github','github_published','awaiting_external'],
    ['comment','linear_posted','awaiting_external'],
    ['state','in_review','awaiting_external'],
    ['worker','session_closed','completed']
  ])await t.test(lost,async t=>{
    const x=await setup(t,{lost});
    const first=await x.coordinator.submit(x.handle,input);
    assert.equal(first.pending,stage);
    const before=[...x.effects];
    await x.jobStore.transition(defaultScope.jobKey,'running',{
      submissionMode:'managed',submissionId:first.submissionId,pid:1234});
    assert.equal(await x.jobStore.reconcile(),1);
    const {coordinator,lease}=offline(x);
    t.after(lease.release);
    await assert.rejects(coordinator.bind({}),/SUBMISSION_DISABLED/);
    await assert.rejects(coordinator.recoverInterrupted(defaultScope.jobKey,'wrong'),/NOT_AUTHORIZED/);
    const recovered=await coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery);
    assert.equal(recovered.stage,stage);
    assert.equal(recovered.continuationRequired,state!=='completed');
    assert.equal((await x.jobStore.get(defaultScope.jobKey)).state,state);
    assert.deepEqual(x.effects,before);
    assert.equal(x.outbox.get(first.submissionId).pending,null);
    if(state!=='completed')await assert.rejects(coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery),/CONTINUATION_REQUIRED/);
    lease.release();
    await assert.rejects(coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery),/RECOVERY_DENIED/);
  });
});
test('M5 terminal durable receipt repairs crash before job-ledger completion only after re-observation',async t=>{
  const x=await setup(t);
  const terminal=await x.coordinator.submit(x.handle,input);
  assert.equal(terminal.stage,'session_closed');
  await x.jobStore.transition(defaultScope.jobKey,'interrupted',{submissionMode:'managed'});
  const {coordinator,lease}=offline(x);t.after(lease.release);
  assert.equal((await coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery)).stage,'session_closed');
  assert.equal((await x.jobStore.get(defaultScope.jobKey)).state,'completed');
  assert.deepEqual(x.effects,['github','comment','state','worker']);
});
test('M5 offline recovery rejects unquiesced jobs and changed scope or false observation',async t=>{
  const x=await setup(t,{lost:'github'});
  const first=await x.coordinator.submit(x.handle,input);
  await x.jobStore.transition(defaultScope.jobKey,'interrupted',{submissionMode:'managed',submissionId:first.submissionId});
  let quiet=false;
  const {coordinator,lease}=offline(x,{assertQuiescent:()=>quiet});
  t.after(lease.release);
  await assert.rejects(coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery),/NOT_QUIESCENT/);
  quiet=true;
  await x.jobStore.transition(defaultScope.jobKey,'interrupted',{githubAppId:'999'});
  await assert.rejects(coordinator.recoverInterrupted(defaultScope.jobKey,x.recovery),/JOURNAL_MISMATCH/);
  assert.deepEqual(x.effects,['github']);
  assert.equal(x.outbox.get(first.submissionId).pending,'github_published');
});
test('M5 exclusive lease rejects a second process and releases after holder crash',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'abr17-exclusive-'));
  t.after(()=>rm(root,{force:true,recursive:true}));
  const url=new URL('../jobs/persistence/submission-exclusive-lease.mjs',import.meta.url).href;
  const code='import {acquireSubmissionLease} from '+JSON.stringify(url)+'; acquireSubmissionLease(process.argv[1]); console.log("HELD"); setInterval(()=>{},1000);';
  const child=spawn(process.execPath,['--input-type=module','-e',code,root],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  const [chunk]=await once(child.stdout,'data');
  assert.equal(chunk.toString().trim(),'HELD');
  assert.throws(()=>acquireSubmissionLease(root),/AUTHORITY_BUSY/);
  const done=once(child,'close');child.kill('SIGKILL');await done;
  const lease=acquireSubmissionLease(root);
  assert.equal(lease.isHeld(),true);
  assert.equal((await stat(path.join(root,'job-state/submission-exclusive.sqlite'))).mode&0o777,0o600);
  lease.release();assert.equal(lease.isHeld(),false);
});


test('M5 actual isolated Bubblewrap preserves private CLI FD and denies host filesystem/network',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'abr17-confined-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sentinel=path.join(root,'host-only.txt');
  await writeFile(sentinel,'fixture-only');
  const server=net.createServer(socket=>socket.end('host fixture'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const args=['--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc',
    '--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib',
    '--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
    '--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp'];
  const result=execFileSync('/usr/bin/bwrap',[...args,'--','/usr/bin/python3','-c',
    'import os,socket,sys,json; s=socket.socket(); s.settimeout(0.2); code=s.connect_ex(("127.0.0.1",int(sys.argv[2]))); print(json.dumps({"hostFileVisible":os.path.exists(sys.argv[1]),"hostNetworkReachable":code==0}))',
    sentinel,String(server.address().port)],{timeout:5000,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.deepEqual(JSON.parse(result),{hostFileVisible:false,hostNetworkReachable:false});
  // CI checkout ancestors may be inaccessible inside a new user namespace.
  // Copy only the exact command bytes into our private fixture and pin the
  // file descriptor. Never expose the checkout, home or credentials.
  const cli=path.join(root,'submit-work.mjs');
  await copyFile(new URL('./submit-work.mjs',import.meta.url),cli);
  const pinned=await open(cli,'r');
  let child;
  try{
    child=spawn('/usr/bin/bwrap',[...args,'--ro-bind',process.execPath,'/node',
      '--ro-bind-fd','4','/submit-work.mjs','--','/node','/submit-work.mjs','ABR-17','Isolated FD fixture'],
      {env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe','pipe',pinned.fd]});
  }finally{await pinned.close();}
  let submitted=0,stdout='',stderr='';
  const done=once(child,'close');t.after(()=>child.kill());
  child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  serveSubmissionChannel(child.stdio[3],{token:null,runnerEvidence:null,timeoutMs:5000,coordinator:{},
    ingress:{async submitLocal({input}){submitted++;assert.deepEqual(input,{issueId:'ABR-17',summary:'Isolated FD fixture'});
      return {stage:'session_closed',pending:null};}}});
  const [code]=await done;
  assert.equal(code,0,stderr);assert.equal(submitted,1);
  assert.equal(JSON.parse(stdout).stage,'session_closed');
});


test('M5 release activation cannot use root test execution as service approval',async()=>{
  const {verifyManagedSubmissionActivation}=await import('../bridge/orchestration/managed-submission-service.mjs');
  if(process.getuid()===0)await assert.rejects(verifyManagedSubmissionActivation({
    verifyActivation:()=>{throw Error('root fixture must not consult release permission');}},'/fixture'),
    /HOST_NOT_APPROVED/);
  else await assert.rejects(verifyManagedSubmissionActivation({},'/fixture'),/HOST_NOT_APPROVED/);
});
