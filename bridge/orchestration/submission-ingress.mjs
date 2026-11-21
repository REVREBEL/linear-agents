// ABR-17 M2: opt-in trusted local runner transport. No network listener or
// credential discovery in this module. The launcher owns the private channel.
import { createHash, randomBytes } from 'node:crypto';
const ID=/^[A-Za-z0-9_.:@/-]{1,256}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE=/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/;
const STATES=new Set(['running','launching','awaiting_external']);
const MAPPING=['agentId','repository','appId','installationId','repositoryNumericId'];
const FIELDS=['role','jobKey','sessionId','issueUuid','issueIdentifier','tenantId','agentId',
  'hostId','repository','repositoryRoot','branch','base','appId','installationId','cycle','headSha'];
const digest=value=>createHash('sha256').update(value).digest();
const numeric=s=>typeof s==='string'&&/^[1-9][0-9]{0,15}$/.test(s)&&Number.isSafeInteger(Number(s));
function denied(code='SUBMISSION_INGRESS_DENIED'){return Object.assign(Error(code),{code});}
function validate(s) {
  if(!s||s.role!=='coding'||!FIELDS.every(k=>typeof s[k]==='string')||
     !UUID.test(s.issueUuid)||!ISSUE.test(s.issueIdentifier)||!REPO.test(s.repository)||
     !SHA.test(s.headSha)||!s.repositoryRoot.startsWith('/')||s.repositoryRoot==='/'||
     !numeric(s.appId)||!numeric(s.installationId)||
     !['rebel-server','macos-runtime'].includes(s.hostId)||
     !['jobKey','sessionId','tenantId','agentId','branch','base','cycle'].every(k=>ID.test(s[k]))||
     s.branch===s.base)throw denied('INVALID_TRUSTED_LAUNCH_SCOPE');
  return Object.freeze(Object.fromEntries(FIELDS.map(k=>[k,s[k]])));
}
function match(job,s) {
  if(!job||!STATES.has(job.state)||job.key!==s.jobKey||job.agent!==s.agentId||
     job.agentSessionId!==s.sessionId||job.issueId!==s.issueUuid||
     job.issueIdentifier!==s.issueIdentifier||job.tenantId!==s.tenantId||
     job.executionHost!==s.hostId||job.repositoryRoot!==s.repositoryRoot||
     job.repositoryId!==s.repository||job.branch!==s.branch||job.baseBranch!==s.base||
     job.githubAppId!==s.appId||job.githubInstallationId!==s.installationId||
     job.submissionCycle!==s.cycle||job.expectedHeadSha!==s.headSha)
    throw denied('SUBMISSION_JOB_SCOPE_MISMATCH');
}
export function createSubmissionIngress({jobStore,verifyLauncher,verifyRunner,mappings,
  enabled=false,now=Date.now,ttlMs=300_000,maxSessions=128}={}) {
  if(typeof jobStore?.get!=='function'||typeof verifyLauncher!=='function'||
     typeof verifyRunner!=='function'||!Array.isArray(mappings)||
     !Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3600000||
     !Number.isInteger(maxSessions)||maxSessions<1||maxSessions>1024)throw denied('TRUSTED_INGRESS_CONFIG_REQUIRED');
  const configured=new Map();
  for(const item of mappings){
    if(!item||!MAPPING.every(k=>typeof item[k]==='string')||
       !ID.test(item.agentId)||!REPO.test(item.repository)||
       !['appId','installationId','repositoryNumericId'].every(k=>numeric(item[k])))throw denied('INVALID_APP_MAPPING');
    const key=item.agentId+'\0'+item.repository;
    if(configured.has(key))throw denied('AMBIGUOUS_APP_MAPPING');
    configured.set(key,Object.freeze(Object.fromEntries(MAPPING.map(k=>[k,item[k]]))));
  }
  const tokens=new Map(), proofs=new WeakMap();
  const lookup=scope=>configured.get(scope.agentId+'\0'+scope.repository);
  const live=entry=>{if(!enabled||!entry||entry.revoked||entry.expiresAt<=now())throw denied();};
  async function issue(launcherEvidence){
    if(!enabled)throw denied('SUBMISSION_DISABLED');
    // A trusted launcher verifier derives these values from authenticated
    // route and the runner binding, not from issue descriptions/env/CLI args.
    const grant=await verifyLauncher(launcherEvidence);
    const scope=validate(grant?.scope);
    const mapping=lookup(scope);
    if(!mapping||mapping.appId!==scope.appId||mapping.installationId!==scope.installationId||
       !grant.runnerIdentity||typeof grant.runnerIdentity!=='object'||
       !Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now())throw denied('UNAPPROVED_APP_OR_RUNNER');
    match(await jobStore.get(scope.jobKey),scope);
    if(grant.expiresAt<=now())throw denied();
    for(const [key,e] of tokens)if(e.revoked||e.expiresAt<=now())tokens.delete(key);
    if(tokens.size>=maxSessions)throw denied('SUBMISSION_INGRESS_CAPACITY');
    if([...tokens.values()].some(e=>e.scope.jobKey===scope.jobKey))throw denied('RUNNER_CAPABILITY_ALREADY_ISSUED');
    const token=randomBytes(32).toString('base64url'),hash=digest(token).toString('hex');
    const entry={scope,runnerIdentity:grant.runnerIdentity,expiresAt:Math.min(grant.expiresAt,now()+ttlMs),revoked:false};
    tokens.set(hash,entry);
    // Token is a single-job local transport capability, never the GitHub
    // token/Linear OAuth/Bridge secret. Deliver via private launcher channel.
    return Object.freeze({token,expiresAt:entry.expiresAt,revoke:()=>{entry.revoked=true;tokens.delete(hash);}});
  }
  async function authenticate(token,runnerEvidence){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw denied();
    const entry=tokens.get(digest(token).toString('hex'));live(entry);
    if(await verifyRunner(runnerEvidence,entry.runnerIdentity)!==true)throw denied();
    live(entry);
    match(await jobStore.get(entry.scope.jobKey),entry.scope);
    live(entry);
    const proof=Object.freeze({});
    proofs.set(proof,entry);
    return proof;
  }
  function verifyAdmission(proof){
    const entry=proofs.get(proof);live(entry);
    return Object.freeze({...entry.scope,expiresAt:entry.expiresAt});
  }
  async function submitLocal({token,runnerEvidence,input},coordinator){
    // Private transport evidence must be derived outside model request body.
    if(!input||Object.keys(input).some(k=>!['issueId','summary'].includes(k))||
       typeof input.issueId!=='string'||typeof input.summary!=='string')throw denied('INVALID_SUBMISSION_INPUT');
    const request=Object.freeze({issueId:input.issueId,summary:input.summary});
    if(Buffer.byteLength(request.issueId)>128||Buffer.byteLength(request.summary)>8192)
      throw denied('INVALID_SUBMISSION_INPUT');
    const proof=await authenticate(token,runnerEvidence);
    const entry=proofs.get(proof);
    const handle=await coordinator.bind(proof);
    try {live(entry);return await coordinator.submit(handle,request);}
    finally{coordinator.revoke(handle);}
  }
  function isAdmissionLive(proof){
    try{live(proofs.get(proof));return true;}catch{return false;}
  }
  return Object.freeze({issue,authenticate,verifyAdmission,isAdmissionLive,submitLocal});
}

// Use this only when constructing the existing canonical claim/transition
// from already authenticated route and inspected worktree metadata.
export function submissionLedgerFields(trustedScope){
  const s=validate(trustedScope);
  return Object.freeze({agent:s.agentId,agentSessionId:s.sessionId,issueId:s.issueUuid,
    issueIdentifier:s.issueIdentifier,tenantId:s.tenantId,executionHost:s.hostId,
    repositoryId:s.repository,repositoryRoot:s.repositoryRoot,branch:s.branch,
    baseBranch:s.base,githubAppId:s.appId,githubInstallationId:s.installationId,
    submissionCycle:s.cycle,expectedHeadSha:s.headSha});
}
