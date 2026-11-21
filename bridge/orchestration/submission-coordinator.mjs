// ABR-17 M1 — no live network, shell, listener or credentials.
// Explicit trusted adapters are required; disabled until the runtime binds them.
import { createHash } from 'node:crypto';
import { sanitizeCheckpointText } from '../../memory/active-task-memory.mjs';

const SHA=/^[0-9a-f]{40}$/;
const REPO=/^[\w.-]+\/[\w.-]+$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_.:@/-]{1,256}$/;
const ISSUE=/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/;
const ACTIVE=new Set(['running','launching','awaiting_external']);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid=(value,pattern=ID)=>typeof value==='string'&&pattern.test(value);
const scopeFields=['jobKey','sessionId','issueUuid','issueIdentifier','tenantId','agentId',
  'hostId','repository','repositoryRoot','branch','base','installationId','appId','cycle','headSha'];
function freezeScope(raw,now) {
  if(!raw || !scopeFields.every(k=>typeof raw[k]==='string') ||
     !valid(raw.issueUuid,UUID)||!valid(raw.issueIdentifier,ISSUE)||
     !valid(raw.repository,REPO)||!valid(raw.headSha,SHA)||
     !raw.repositoryRoot.startsWith('/')||raw.repositoryRoot==='/'||
     !valid(raw.branch)||!valid(raw.base)||raw.branch===raw.base||
     !valid(raw.jobKey)||!valid(raw.sessionId)||!valid(raw.tenantId)||!valid(raw.agentId)||
     !valid(raw.hostId)||!valid(raw.cycle)||
     !valid(raw.installationId,/^[1-9][0-9]{0,18}$/)||!valid(raw.appId,/^[1-9][0-9]{0,18}$/)||
     !Number.isSafeInteger(raw.expiresAt)||raw.expiresAt<=now()||
     raw.expiresAt>now()+60*60_000||raw.role!=='coding')
    throw Error('UNVERIFIED_SUBMISSION_ADMISSION');
  return Object.freeze({...Object.fromEntries(scopeFields.map(k=>[k,raw[k]])),expiresAt:raw.expiresAt});
}
function summarize(value) {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>8192)
    throw Error('INVALID_SUBMISSION_SUMMARY');
  return sanitizeCheckpointText(value).replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(/\s+/g,' ').slice(0,1500).trim();
}
function assertJob(job,s,{closed=false,failed=false,recovering=false}={}) {
  if(!job||(!ACTIVE.has(job.state)&&!(closed&&job.state==='completed')&&!(failed&&job.state==='failed')&&!(recovering&&['interrupted','awaiting_external'].includes(job.state)))||
     job.key!==s.jobKey||job.agentSessionId!==s.sessionId||job.issueId!==s.issueUuid||
     job.issueIdentifier!==s.issueIdentifier||job.tenantId!==s.tenantId||
     job.agent!==s.agentId||job.executionHost!==s.hostId||
     job.repositoryId!==s.repository||job.repositoryRoot!==s.repositoryRoot||
     job.branch!==s.branch||job.baseBranch!==s.base||
     job.githubInstallationId!==s.installationId||job.githubAppId!==s.appId||
     job.submissionCycle!==s.cycle||job.expectedHeadSha!==s.headSha)
    throw Error('SUBMISSION_JOB_SCOPE_MISMATCH');
}
function result(row) {
  return Object.freeze({submissionId:row.id,stage:row.stage,pending:row.pending,
    status:row.pending?'reconciliation_required':row.stage,
    ...(row.github?{prNumber:row.github.number,headSha:row.github.headSha,prUrl:row.github.url}:{}),
    reviewQueued:!!row.review, reviewerAcknowledged:false,issueCompleted:false});
}
const steps=[
  ['received','validated'],['validated','git_ready'],['git_ready','github_published'],
  ['github_published','linear_posted'],['linear_posted','in_review'],
  ['in_review','review_queued'],['review_queued','session_closed'],
];
const nextStep=new Map(steps);
const methods={git_ready:'inspectGit',github_published:'publishGitHub',linear_posted:'postLinear',
  in_review:'moveInReview',review_queued:'queueReview',session_closed:'closeSession'};
function checkReceipt(step,value,s,row) {
  // Keep only reviewed data fields. Never persist raw API responses or secrets.
  if(!value||value.verified!==true) throw Error('UNVERIFIED_SUBMISSION_RECEIPT');
  if(step==='git_ready') {
    if(value.repository!==s.repository||value.repositoryRoot!==s.repositoryRoot||
       value.branch!==s.branch||value.base!==s.base||value.headSha!==s.headSha||
       value.remoteHeadSha!==s.headSha||value.clean!==true||value.detached!==false||
       value.conflicts!==false||value.checksPassed!==true||value.installationId!==s.installationId||
       value.appId!==s.appId) throw Error('GIT_NOT_READY');
    return {git:{headSha:s.headSha,checksPassed:true}};
  }
  if(step==='github_published') {
    if(!Number.isSafeInteger(value.number)||value.number<=0||
       value.repository!==s.repository||value.branch!==s.branch||value.base!==s.base||
       value.headSha!==s.headSha||value.installationId!==s.installationId||
       value.appId!==s.appId||value.state!=='open'||value.draft!==false||
       value.url!==`https://github.com/${s.repository}/pull/${value.number}`||
       (row.previousPr&&row.previousPr.number!==value.number))
      throw Error('UNVERIFIED_GITHUB_PUBLICATION');
    return {github:{number:value.number,url:value.url,headSha:value.headSha,
      previousHeadSha:row.previousPr?.headSha??null}};
  }
  if(step==='linear_posted') {
    if(value.issueUuid!==s.issueUuid||!valid(value.commentId)||
       value.headSha!==s.headSha||value.agentId!==s.agentId)
      throw Error('UNVERIFIED_LINEAR_COMMENT');
    return {linear:{commentId:value.commentId}};
  }
  if(step==='in_review') {
    if(value.issueUuid!==s.issueUuid||value.state!=='In Review'||value.agentId!==s.agentId)
      throw Error('UNVERIFIED_LINEAR_TRANSITION');
    return {workflow:{state:'In Review'}};
  }
  if(step==='review_queued') {
    if(value.repository!==s.repository||value.number!==row.github.number||
       value.headSha!==s.headSha||!valid(value.reviewId))
      throw Error('UNVERIFIED_REVIEW_QUEUE');
    return {review:{reviewId:value.reviewId}};
  }
  if(step==='session_closed') {
    if(value.sessionId!==s.sessionId||value.status!=='completed'||value.agentId!==s.agentId)
      throw Error('UNVERIFIED_SESSION_COMPLETION');
    return {completion:{status:'completed'}};
  }
  throw Error('INVALID_SUBMISSION_STAGE');
}
export function createSubmissionCoordinator({jobStore,outbox,verifyAdmission,isAdmissionLive=()=>true,verifyRecovery=null,adapters,enabled=false,operatorRecovery=null,now=Date.now}) {
  if(!jobStore?.get||!outbox?.claim||typeof verifyAdmission!=='function'||typeof isAdmissionLive!=='function'||
     !adapters||Object.values(methods).some(name=>typeof adapters[name]!=='function'))
    throw TypeError('TRUSTED_SUBMISSION_ADAPTERS_REQUIRED');
  if(operatorRecovery!==null && (typeof operatorRecovery.verify!=='function' ||
    typeof operatorRecovery.assertExclusive!=='function' || typeof operatorRecovery.assertQuiescent!=='function' || typeof jobStore.transition!=='function'))
    throw TypeError('OPERATOR_RECOVERY_BOUNDARY_REQUIRED');
  const handles=new WeakMap();
  async function bind(evidence) {
    if(!enabled||operatorRecovery) throw Error('SUBMISSION_DISABLED');
    const s=freezeScope(await verifyAdmission(evidence),now);
    const prior=outbox.get(key(s));
    assertJob(await jobStore.get(s.jobKey),s,{closed:prior?.stage==='session_closed',failed:['blocked','failed'].includes(prior?.stage)});
    if(s.expiresAt<=now()||isAdmissionLive(evidence)!==true) throw Error('UNVERIFIED_SUBMISSION_ADMISSION');
    const handle=Object.freeze({});
    handles.set(handle,{scope:s,evidence});
    return handle;
  }
  function requireHandle(handle) {
    const entry=handles.get(handle),s=entry?.scope;
    if(!enabled||!s||s.expiresAt<=now()||isAdmissionLive(entry.evidence)!==true)
      throw Error('SUBMISSION_CAPABILITY_REQUIRED');
    return s;
  }
  function key(s) {
    return digest([s.jobKey,s.sessionId,s.issueUuid,s.cycle,s.headSha]);
  }
  async function submit(handle,input) {
    const s=requireHandle(handle);
    if(!input||Object.keys(input).some(k=>!['issueId','summary'].includes(k))||
       ![s.issueUuid,s.issueIdentifier].includes(input.issueId))
      throw Error('SUBMISSION_ISSUE_CONFIRMATION_REQUIRED');
    const summary=summarize(input.summary);
    const id=key(s);
    // Completed retries are read-only; they cannot publish or close again.
    const existing=outbox.get(id);
    assertJob(await jobStore.get(s.jobKey),s,{closed:existing?.stage==='session_closed'});
    requireHandle(handle);
    const scopeDigest=digest(scopeFields.map(k=>s[k]));
    const publicationScope=digest([s.repository,s.branch,s.base,s.installationId,s.appId]);
    let row=outbox.claim({id,issueScope:digest([s.tenantId,s.issueUuid]),head:s.headSha,
      data:{summary,scopeDigest,publicationScope}}).record;
    // The claim may have been won by another process after our read.
    if(row.failureOutcome||row.summary!==summary||row.scopeDigest!==scopeDigest)
      throw Error('SUBMISSION_RECEIPT_CONFLICT');
    while(nextStep.has(row.stage)) {
      if(row.pending) return result(row);
      // Revalidate current admission before every external attempt. The
      // durable intent prevents concurrent processes from repeating it.
      requireHandle(handle);
      assertJob(await jobStore.get(s.jobKey),s);
      // Ledger I/O yields control: a revoked/expired handle may no longer
      // authorize the next step even if the returned job still matches.
      requireHandle(handle);
      const prior=row.stage,next=nextStep.get(prior);
      if(!outbox.intent(id,prior,next)) return result(outbox.get(id));
      try {
        let patch={};
        if(next!=='validated') {
          const context=Object.freeze({scope:s,summary:row.summary,
            github:row.github?Object.freeze({...row.github}):null,
            previousPr:row.previousPr?Object.freeze({...row.previousPr}):null,
            operationId:digest([id,next]),
            authorize:async()=>{requireHandle(handle);assertJob(await jobStore.get(s.jobKey),s);requireHandle(handle);}});
          requireHandle(handle);
          const receipt=await adapters[methods[next]](context);
          patch=checkReceipt(next,receipt,s,row);
        }
        row=outbox.advance(id,prior,next,patch);
      } catch {
        // A failed or timed-out adapter may have committed external effects.
        // Preserve intent. Never retry/write or infer success automatically.
        return result(outbox.get(id));
      }
    }
    return result(row);
  }
  // Explicit trusted recovery only: a provider response or operator-confirmed
  // observation must describe the exact pending operation and current scope.
  // This method never repeats an external effect or advances on a guess.
  async function reconcilePending(handle,evidence) {
    const s=requireHandle(handle),id=key(s),row=outbox.get(id);
    if(!row?.pending||!verifyRecovery) throw Error('SUBMISSION_RECONCILIATION_NOT_AVAILABLE');
    assertJob(await jobStore.get(s.jobKey),s);
    requireHandle(handle);
    const observation=await verifyRecovery(evidence,Object.freeze({
      scope:s,summary:row.summary,submissionId:id,stage:row.pending,operationId:digest([id,row.pending]),
      authorize:async()=>{requireHandle(handle);assertJob(await jobStore.get(s.jobKey),s);requireHandle(handle);},
      github:row.github?Object.freeze({...row.github}):null,
      previousPr:row.previousPr?Object.freeze({...row.previousPr}):null,
    }));
    if(!observation||observation.operationId!==digest([id,row.pending])||
       observation.stage!==row.pending||observation.confirmed!==true)
      throw Error('UNVERIFIED_SUBMISSION_RECONCILIATION');
    requireHandle(handle);
    assertJob(await jobStore.get(s.jobKey),s);
    requireHandle(handle);
    const patch=row.pending==='validated'?{}:
      ['failed','blocked'].includes(row.pending)?failureReceipt(observation.receipt,s,row.pending):
      checkReceipt(row.pending,observation.receipt,s,row);
    return result(outbox.advance(id,row.stage,row.pending,patch));
  }
  function failureReceipt(value,s,outcome){
    if(!value||value.verified!==true||value.sessionId!==s.sessionId||
       value.agentId!==s.agentId||value.status!=='failed')throw Error('UNVERIFIED_FAILED_SESSION');
    return {completion:{status:'failed'},outcome};
  }
  // Explicit failure from a trusted runner, not an interpretation of tool
  // text or a timeout. Never publishes or moves an issue to In Review.
  async function submitFailure(handle,{issueId,summary,outcome}={}){
    const s=requireHandle(handle),id=key(s);
    if(!['blocked','failed'].includes(outcome)||![s.issueUuid,s.issueIdentifier].includes(issueId)||
      typeof adapters.closeFailedSession!=='function')throw Error('FAILED_SUBMISSION_DENIED');
    const text=summarize(summary);
    const existing=outbox.get(id);
    assertJob(await jobStore.get(s.jobKey),s,{failed:['blocked','failed'].includes(existing?.stage)});
    requireHandle(handle);
    const row=outbox.claim({id,issueScope:digest([s.tenantId,s.issueUuid]),head:s.headSha,
      data:{summary:text,scopeDigest:digest(scopeFields.map(k=>s[k])),
        publicationScope:digest([s.repository,s.branch,s.base,s.installationId,s.appId]),failureOutcome:outcome}}).record;
    if(row.failureOutcome!==outcome||row.summary!==text||row.scopeDigest!==digest(scopeFields.map(k=>s[k])))
      throw Error('FAILURE_SUBMISSION_CONFLICT');
    if(row.stage===outcome||row.pending===outcome)return result(row);
    if(row.stage!=='received'||row.pending||!outbox.intent(id,'received',outcome))throw Error('FAILURE_SUBMISSION_CONFLICT');
    try{
      const authorize=async()=>{requireHandle(handle);assertJob(await jobStore.get(s.jobKey),s);requireHandle(handle);};
      await authorize();
      const receipt=await adapters.closeFailedSession(Object.freeze({scope:s,summary:text,outcome,
        operationId:digest([id,outcome]),authorize}));
      return result(outbox.advance(id,'received',outcome,failureReceipt(receipt,s,outcome)));
    }catch{return result(outbox.get(id));}
  }
  // Operator-only restart recovery. No live runner handle is minted and
  // no publication adapter is invoked. An exclusive offline lease and
  // independently approved exact receipt are required for every operation.
  async function recoverInterrupted(jobKey,evidence){
    if(!enabled||!operatorRecovery||typeof verifyRecovery!=='function'||!valid(jobKey))
      throw Error('OPERATOR_RECOVERY_DENIED');
    const exclusive=()=>{if(operatorRecovery.assertExclusive()!==true)throw Error('OPERATOR_RECOVERY_DENIED');};
    exclusive();
    const job=await jobStore.get(jobKey);
    if(!job||job.submissionMode!=='managed'||!['interrupted','awaiting_external'].includes(job.state)||
      operatorRecovery.assertQuiescent(job)!==true)
      throw Error('OPERATOR_RECOVERY_JOB_NOT_QUIESCENT');
    const s=freezeScope({role:'coding',jobKey,sessionId:job.agentSessionId,
      issueUuid:job.issueId,issueIdentifier:job.issueIdentifier,tenantId:job.tenantId,
      agentId:job.agent,hostId:job.executionHost,repository:job.repositoryId,
      repositoryRoot:job.repositoryRoot,branch:job.branch,base:job.baseBranch,
      appId:job.githubAppId,installationId:job.githubInstallationId,
      cycle:job.submissionCycle,headSha:job.expectedHeadSha,expiresAt:now()+60_000},now);
    assertJob(job,s,{recovering:true});
    const id=key(s),row=outbox.get(id);
    if(!row||row.scopeDigest!==digest(scopeFields.map(k=>s[k]))||
      (job.submissionId&&job.submissionId!==id))throw Error('OPERATOR_RECOVERY_JOURNAL_MISMATCH');
    const terminal=['session_closed','failed','blocked'].includes(row.stage)&&row.pending===null;
    const target=row.pending||(terminal?row.stage:null);
    if(!target)throw Error('OPERATOR_RECOVERY_CONTINUATION_REQUIRED');
    const approval=Object.freeze({jobKey,submissionId:id,stage:target,
      operationId:digest([id,target]),headSha:s.headSha,scope:s});
    if(await operatorRecovery.verify(evidence,approval)!==true)
      throw Error('OPERATOR_RECOVERY_NOT_AUTHORIZED');
    const authorize=async()=>{
      exclusive();
      if(s.expiresAt<=now())throw Error('OPERATOR_RECOVERY_DENIED');
      const current=await jobStore.get(jobKey);
      assertJob(current,s,{recovering:true});
      if(current.submissionMode!=='managed'||operatorRecovery.assertQuiescent(current)!==true||
        current.state!==job.state||current.updatedAt!==job.updatedAt)throw Error('OPERATOR_RECOVERY_JOB_CHANGED');
      exclusive();
    };
    await authorize();
    const observation=await verifyRecovery(evidence,Object.freeze({
      ...approval,summary:row.summary,authorize,
      github:row.github?Object.freeze({...row.github}):null,
      previousPr:row.previousPr?Object.freeze({...row.previousPr}):null,
    }));
    if(observation?.confirmed!==true||observation.operationId!==approval.operationId||
      observation.stage!==target)throw Error('UNVERIFIED_SUBMISSION_RECONCILIATION');
    const patch=target==='validated'?{}:
      ['failed','blocked'].includes(target)?failureReceipt(observation.receipt,s,target):
      checkReceipt(target,observation.receipt,s,row);
    await authorize();
    // This is an observed-effect repair, never a request to perform the next
    // effect. A crash after journal advancement is repaired by re-observing
    // the terminal stage, not by replaying a provider mutation.
    const saved=terminal?outbox.get(id):outbox.advance(id,row.stage,target,patch);
    if(!saved||saved.stage!==target||saved.pending!==null)
      throw Error('STALE_SUBMISSION_INTENT');
    const finished=['session_closed','failed','blocked'].includes(saved.stage);
    await jobStore.transition(jobKey,finished?(saved.stage==='session_closed'?'completed':'failed'):'awaiting_external',{
      submissionId:id,submissionStage:saved.stage,submissionPending:null,pid:null,
      ...(finished?{completionConfirmedAt:new Date(now()).toISOString()}:
        {note:'Verified prior effect; further publication requires separately authorized continuation'}),
    });
    return Object.freeze({...result(saved),continuationRequired:!finished});
  }
  return Object.freeze({bind,submit,submitFailure,reconcilePending,recoverInterrupted,revoke:handle=>handles.delete(handle)});
}
