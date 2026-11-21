// ABR-17 M3 — composition of real host-only provider clients. No startup
// side effects. Trusted configuration and per-effect authority are mandatory.
import { resolveGithubReviewDestination, githubReviewChangeKey } from '../../integrations/github-events.mjs';
import { createHash } from 'node:crypto';
const fail=()=>Error('SUBMISSION_PUBLICATION_NOT_VERIFIED');
const sha=/^[a-f0-9]{40}$/;
const marker=s=>'<!-- bridge-issue:'+createHash('sha256').update(JSON.stringify([s.tenantId,s.issueUuid,s.repository])).digest('hex')+' -->';
const eventFor=c=>({event:'pull_request',action:'ready_for_review',repository:c.scope.repository,
  number:c.github.number,url:c.github.url,headSha:c.scope.headSha,draft:false});
export function createSubmissionPublicationAdapters({gitPreflight,githubBroker,linearWorker,
  reviewInbox,reviewRoutingConfig,publicationPolicies,verifyRecoveryRequest}={}){
  if(!gitPreflight?.inspectGit||!githubBroker?.forScope||!linearWorker?.postLinear||
    !reviewInbox?.enqueue||!reviewInbox?.get||typeof verifyRecoveryRequest!=='function'||
    !Array.isArray(publicationPolicies))throw fail();
  const policies=new Map();
  for(const p of publicationPolicies){
    if(!p||typeof p.repository!=='string'||typeof p.agentId!=='string'||
       typeof p.botUserId!=='string'||!/^\d+$/.test(p.botUserId)||!['ready','draft'].includes(p.mode))throw fail();
    const key=p.agentId+'\0'+p.repository;
    if(policies.has(key))throw fail();
    policies.set(key,Object.freeze({...p}));
  }
  function policy(s){const p=policies.get(s.agentId+'\0'+s.repository);if(!p)throw fail();return p;}
  async function verifiedGit(c){
    const evidence=await gitPreflight.inspectGit(c);
    const s=c.scope;
    if(evidence?.verified!==true||evidence.headSha!==s.headSha||evidence.remoteHeadSha!==s.headSha||
      evidence.base!==s.base||evidence.repository!==s.repository||evidence.branch!==s.branch||
      evidence.checksPassed!==true||evidence.clean!==true)throw fail();
    return evidence;
  }
  async function githubContext(c){
    const p=policy(c.scope),client=await githubBroker.forScope(c.scope);
    if(!client.findOpenPull||!client.getPull||!client.createPull)throw fail();
    return {p,client};
  }
  function verifyPr(c,p,pr){
    const s=c.scope;
    if(!pr||pr.headSha!==s.headSha||pr.authorId!==p.botUserId||
       pr.url!==`https://github.com/${s.repository}/pull/${pr.number}`||
       !pr.body.split('\n').includes(marker(s))||
       (c.previousPr&&c.previousPr.number!==pr.number)||
       (c.github&&c.github.number!==pr.number)||pr.draft!==false)throw fail();
    return {verified:true,number:pr.number,url:pr.url,headSha:s.headSha,
      repository:s.repository,branch:s.branch,base:s.base,appId:s.appId,
      installationId:s.installationId,state:'open',draft:false};
  }
  async function observePr(c){
    const {p,client}=await githubContext(c);
    await verifiedGit(c);
    const pr=await client.findOpenPull();
    if(!pr)throw fail();
    return verifyPr(c,p,await client.getPull(pr.number));
  }
  async function publishGitHub(c){
    const {p,client}=await githubContext(c);
    if(!resolveGithubReviewDestination(reviewRoutingConfig,c.scope.repository).ok)throw fail();
    await verifiedGit(c);
    let pr=await client.findOpenPull();
    if(!pr){
      // A known prior PR cannot be replaced by a new one.
      if(c.previousPr)throw fail();
      pr=await client.createPull({
        title:c.scope.issueIdentifier+' — Bridge submission',
        body:[marker(c.scope),'Agent summary (descriptive): '+c.summary.replace(/[<>]/g,' '),
          'Initial verified head: '+c.scope.headSha,'Configured required checks passed before initial publication. Later revisions use the current PR head and verified Linear submission comment.'].join('\n\n'),
        draft:p.mode==='draft',authorize:async()=>{
          await verifiedGit(c);await c.authorize();
        }});
    }
    // Drafts are deliberate external effects, not ready-for-review receipts.
    // Leave durable intent pending; operator may mark ready and verify via
    // read-only recovery. Never transition Linear on an unready draft.
    const current=await client.getPull(pr.number);
    await verifiedGit(c);
    return verifyPr(c,p,current);
  }
  async function ready(c){
    await observePr(c);
  }
  async function observeQueue(c){
    await ready(c);
    const event=eventFor(c),id=githubReviewChangeKey(event),row=await reviewInbox.get(id);
    if(!row||row.reviewId!==id||row.repository!==event.repository||
      row.number!==event.number||row.headSha!==event.headSha||row.role!=='chatgpt-user-review')throw fail();
    return {verified:true,reviewId:id,repository:event.repository,number:event.number,headSha:event.headSha};
  }
  // Re-check the published head immediately at each downstream mutation
  // boundary, after Linear identity/issue lookups and secret brokerage.
  const atReadyBoundary=c=>Object.freeze({...c,authorize:async()=>{
    await ready(c);await c.authorize();
  }});
  const adapters=Object.freeze({
    inspectGit:verifiedGit,publishGitHub,
    postLinear:async c=>{await ready(c);return linearWorker.postLinear(atReadyBoundary(c));},
    moveInReview:async c=>{
      if(!resolveGithubReviewDestination(reviewRoutingConfig,c.scope.repository).ok)throw fail();
      await ready(c);return linearWorker.moveInReview(atReadyBoundary(c));
    },
    async queueReview(c){
      await ready(c);
      const event=eventFor(c),destination=resolveGithubReviewDestination(reviewRoutingConfig,event.repository);
      if(!destination.ok)throw fail();
      await c.authorize();
      await reviewInbox.enqueue(event,{source:'chatgpt',destination});
      return observeQueue(c);
    },
    closeSession:async c=>{await observeQueue(c);return linearWorker.closeSession(Object.freeze({...c,
      authorize:async()=>{await observeQueue(c);await c.authorize();}}));},
    closeFailedSession:c=>linearWorker.closeFailedSession(c),
  });
  async function verifyRecovery(evidence,c){
    // Trusted operator/host approval only; no caller text/receipt inference.
    if(await verifyRecoveryRequest(evidence,c)!==true)throw fail();
    await c.authorize();
    let receipt;
    switch(c.stage){
      case 'validated':receipt={};break;
      case 'git_ready':receipt=await verifiedGit(c);break;
      case 'github_published':receipt=await observePr(c);break;
      case 'linear_posted':await ready(c);receipt=await linearWorker.observeComment(c);break;
      case 'in_review':await ready(c);receipt=await linearWorker.observeReview(c);break;
      case 'review_queued':receipt=await observeQueue(c);break;
      case 'session_closed':await observeQueue(c);receipt=await linearWorker.observeSession(c,'completed');break;
      case 'blocked':case 'failed':receipt=await linearWorker.observeSession(c,'failed');break;
      default:throw fail();
    }
    return {confirmed:true,operationId:c.operationId,stage:c.stage,receipt};
  }
  return Object.freeze({adapters,verifyRecovery});
}
