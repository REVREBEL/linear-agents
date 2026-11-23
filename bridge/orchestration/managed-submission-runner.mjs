// M4: managed provider finish path. Trusted launcher owns isolation and
// descriptor propagation. Never infer submission from model output/exit code.
import { submissionLedgerFields } from './submission-ingress.mjs';
import { serveSubmissionChannel } from '../handlers/submission-channel.mjs';
import { randomUUID } from 'node:crypto';

export const MANAGED_PROVIDERS=Object.freeze(['antigravity','trae','chatgpt-cli']);
const deny=()=>Error('MANAGED_SUBMISSION_DENIED');
const issuePattern=/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[0-9a-f]{40}$/;
export function createManagedSubmissionRunner({jobStore,ingress,coordinator,
  captureHead,resolvePlan,launchProvider,launchProofs,enabled=false,now=Date.now}){
  if(!jobStore?.get||!jobStore?.transition||!ingress?.issue||!coordinator?.submit||
     typeof captureHead!=='function'||typeof resolvePlan!=='function'||
     typeof launchProvider!=='function'||!(launchProofs instanceof WeakMap))throw deny();
  const active=new Set(),activeRoots=new Set(),finishers=new Map();
  async function run({agent,job,route,jobKey,workspace,filename,prompt,onAccepted=()=>{}}){
    if(!enabled||!MANAGED_PROVIDERS.includes(agent)||route.executionHost!=='bridge-server'||
      active.has(jobKey)||activeRoots.has(route.repositoryRoot)||route.launchDirectory!==workspace||!route.ok||
      typeof prompt!=='string'||!prompt.trim())throw deny();
    active.add(jobKey);activeRoots.add(route.repositoryRoot);
    let accepted=false;
    try {
    const issueUuid=job.issueMetadata?.id||job.issueId;
    const issueIdentifier=job.issueMetadata?.identifier;
    const sessionId=job.agentSessionId||job.payload?.data?.agentSessionId;
    if(!uuid.test(issueUuid||'')||!issuePattern.test(issueIdentifier||'')||
       !uuid.test(sessionId||'')||!uuid.test(job.organizationId||''))throw deny();
    const original=await jobStore.get(jobKey);
    if(!original||original.key!==jobKey||original.agent!==agent||original.state!=='queued'||
      original.issueId!==issueUuid||original.agentSessionId!==sessionId||
      original.repositoryRoot!==route.repositoryRoot||original.workspace!==workspace)throw deny();
    const resolved=await resolvePlan(Object.freeze({agent,issueIdentifier,issueUuid,
      tenantId:job.organizationId,repository:route.repository,repositoryRoot:route.repositoryRoot,
      workspace,projectId:route.projectId,jobKey,sessionId}));
    const p=resolved && Object.freeze({...resolved});
    if(!p||p.repository!==route.repository||p.repositoryRoot!==route.repositoryRoot||
      p.agentId!==agent||p.issueUuid!==issueUuid||p.jobKey!==jobKey||
      p.tenantId!==job.organizationId||p.sessionId!==sessionId||p.workspace!==workspace||
      p.projectId!==route.projectId||p.role!=='coding'||typeof p.branch!=='string'||typeof p.base!=='string'||
      p.branch===p.base||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now()||
      p.expiresAt>now()+3600000||typeof p.commandPath!=='string'||!p.commandPath.startsWith('/'))throw deny();
    const scope=Object.freeze({role:'coding',jobKey,sessionId,issueUuid,issueIdentifier,
      tenantId:job.organizationId,agentId:agent,hostId:'rebel-server',repository:route.repository,
      repositoryRoot:route.repositoryRoot,branch:p.branch,base:p.base,appId:p.appId,
      installationId:p.installationId,cycle:randomUUID()});
    // Only the independent final-head read may fill this field. Initial
    // attribution is not a mintable submission capability.
    const initial=submissionLedgerFields({...scope,headSha:'0'.repeat(40)});
    await jobStore.transition(jobKey,'launching',{...initial,expectedHeadSha:null,
      submissionMode:'managed',submissionStage:'awaiting_request'});
    const runnerIdentity=Object.freeze({}),proof=Object.freeze({});
    let child,cap=null,attempt=null,closed=false,expiryTimer;
    const finishIngress={
      async submitLocal({input,isLive=()=>true}){
        if(closed||attempt||isLive()!==true||p.expiresAt<=now()||!input||typeof input.issueId!=='string'||
          ![issueUuid,issueIdentifier].includes(input.issueId)||
          typeof input.summary!=='string'||!input.summary.trim()||Buffer.byteLength(input.summary)>8192||
          Object.keys(input).some(k=>!['issueId','summary','outcome'].includes(k))||
          (input.outcome!==undefined&&!['failed','blocked'].includes(input.outcome)))throw deny();
        const request=Object.freeze({...input});
        attempt=(async()=>{
          const head=await captureHead(scope);
          if(closed||isLive()!==true||p.expiresAt<=now()||!sha.test(head))throw deny();
          const current=await jobStore.get(jobKey);
          if(closed||current?.submissionMode!=='managed'||current.submissionCycle!==scope.cycle||
            current.state!=='running'||current.expectedHeadSha!==null)throw deny();
          const final=Object.freeze({...scope,headSha:head});
          await jobStore.transition(jobKey,'running',{expectedHeadSha:head,submissionStage:'requested'});
          if(closed||isLive()!==true)throw deny();
          launchProofs.set(proof,{scope:final,runnerIdentity,expiresAt:p.expiresAt,isLive});
          cap=await ingress.issue(proof);
          if(closed){cap.revoke();throw deny();}
          const result=await ingress.submitLocal({token:cap.token,runnerEvidence:runnerIdentity,input:request},coordinator);
          const terminal=result?.pending==null&&['session_closed','failed','blocked'].includes(result?.stage);
          await jobStore.transition(jobKey,terminal?(result.stage==='session_closed'?'completed':'failed'):'awaiting_external',{
            submissionStage:result?.stage||'unverified',submissionId:result?.submissionId||null,
            submissionPending:result?.pending||null,
            ...(terminal?{completionConfirmedAt:new Date(now()).toISOString()}:{})});
          return result;
        })();
        return attempt;
      }
    };
    try{
      // Never send the raw job/credential object or host environment.
      child=launchProvider(Object.freeze({agent,workspace,repositoryRoot:scope.repositoryRoot,
        issueIdentifier,prompt,commandPath:p.commandPath,plan:p,filename}));
      if(!child?.stdio?.[3]||typeof child.once!=='function')throw deny();
      const spawned=new Promise((resolve,reject)=>{
        child.once('spawn',resolve);
        child.once('error',()=>reject(deny()));
        child.once('close',()=>reject(deny()));
      });
      const exit=new Promise(resolve=>{
        child.once('error',()=>resolve({code:null,signal:'spawn-error'}));
        child.once('close',(code,signal)=>resolve({code,signal}));
      });
      // Wait until the scoped ledger is durable before accepting input.
      await spawned;
      await jobStore.transition(jobKey,'running',{pid:child.pid||null,managedLaunchAcceptedAt:new Date(now()).toISOString()});
      finishers.set(jobKey,{scope,submit:(input,isLive)=>finishIngress.submitLocal({input,isLive})});
      expiryTimer=setTimeout(()=>{closed=true;cap?.revoke();child.stdio[3].destroy();child.kill?.();},
        Math.max(1,p.expiresAt-now()));expiryTimer.unref?.();
      serveSubmissionChannel(child.stdio[3],{ingress:finishIngress,coordinator,
        token:null,runnerEvidence:null,timeoutMs:Math.max(100,Math.min(3600000,p.expiresAt-now()))});
      // Discard raw output: it is neither safe diagnostics nor terminal proof.
      child.stdout?.resume();child.stderr?.resume();
      accepted=true;onAccepted();
      const outcome=await exit;
      closed=true;cap?.revoke();
      if(attempt)await attempt.catch(()=>{});
      const record=await jobStore.get(jobKey);
      if(!['completed','failed'].includes(record?.state)){
        await jobStore.transition(jobKey,'awaiting_external',{
          pid:null,exitCode:outcome.code,signal:outcome.signal,
          note:'Managed runner exited; reconcile explicit submission evidence before retrying'});
      }else await jobStore.transition(jobKey,record.state,{pid:null,exitCode:outcome.code,signal:outcome.signal});
    }catch{
      closed=true;cap?.revoke();child?.kill?.();
      if(attempt)await attempt.catch(()=>{});
      const record=await jobStore.get(jobKey);
      if(!['completed','failed'].includes(record?.state))await jobStore.transition(jobKey,'awaiting_external',
        {pid:null,note:'Managed submission launcher or finish failed; inspect canonical ledger'});
      throw deny();
    }finally{clearTimeout(expiryTimer);closed=true;cap?.revoke();launchProofs.delete(proof);finishers.delete(jobKey);}
    } catch(error) {
      if(!accepted){
        const row=await jobStore.get(jobKey);
        if(row?.state==='queued'&&row.agent===agent)
          await jobStore.transition(jobKey,'failed',{error:'Managed launch rejected before spawn'});
      }
      throw error;
    } finally {active.delete(jobKey);activeRoots.delete(route.repositoryRoot);}
  }
  async function submitAdmittedWork(grant,input,isLive){
    const f=finishers.get(grant?.jobKey),s=f?.scope;
    if(!s||typeof isLive!=='function'||isLive()!==true||grant.role!=='coding'||grant.mode!=='linear'||grant.expiresAt<=now()||
       grant.sessionId!==s.sessionId||grant.issueId!==s.issueUuid||grant.tenantId!==s.tenantId||
       grant.agentId!==s.agentId||grant.hostId!==s.hostId||grant.branch!==s.branch||
       grant.repositoryId!==s.repository||grant.repositoryRoot!==s.repositoryRoot)throw deny();
    return f.submit(input,isLive);
  }
  // Acknowledge only once the managed child and its durable attribution
  // exist. Keep execution supervised here, never replay a rejected launch.
  async function dispatch(args){
    let accept,reject;
    const accepted=new Promise((yes,no)=>{accept=yes;reject=no;});
    const completion=run({...args,onAccepted:accept});
    completion.catch(reject);
    await accepted;
    return {completion};
  }
  return Object.freeze({run,dispatch,submitAdmittedWork});
}
