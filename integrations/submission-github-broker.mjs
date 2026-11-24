// Host-only GitHub App credential brokerage. Never export JWTs or installation
// tokens; callers receive a repository-scoped read-only facade in M2.
import { createPrivateKey, sign } from 'node:crypto';
const API='https://api.github.com';
const ID=/^[1-9][0-9]{0,15}$/;
const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/;
const READ={contents:'read',pull_requests:'read',checks:'read',statuses:'read',metadata:'read'};
const fail=()=>Error('GITHUB_SUBMISSION_BROKER_DENIED');
const validRef=v=>typeof v==='string'&&REF.test(v)&&!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.lock');
export function createSubmissionGithubBroker({mappings,loadPrivateKey,fetchImpl=fetch,now=Date.now,allowPublication=false,allowObservation=false}={}){
  if(!Array.isArray(mappings)||typeof loadPrivateKey!=='function'||typeof fetchImpl!=='function')throw fail();
  const APPROVED=Object.freeze({...READ,pull_requests:allowPublication?'write':'read'});
  const map=new Map(),cache=new Map(),inflight=new Map();
  for(const m of mappings){
    if(!m||typeof m.agentId!=='string'||!REPO.test(m.repository)||
       m.repository.split('/').some(x=>x==='.'||x==='..')||
       ![m.appId,m.installationId,m.repositoryNumericId].every(v=>typeof v==='string'&&ID.test(v)&&Number.isSafeInteger(Number(v))))throw fail();
    const k=m.agentId+'\0'+m.repository;
    if(map.has(k))throw fail();
    map.set(k,Object.freeze({agentId:m.agentId,repository:m.repository,
      appId:m.appId,installationId:m.installationId,repositoryNumericId:m.repositoryNumericId}));
  }
  async function request(urlPath,token,method='GET',payload){
    try{
      const response=await fetchImpl(API+urlPath,{method,redirect:'error',
        headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
          'X-GitHub-Api-Version':'2022-11-28','User-Agent':'REVREBEL-Submission-Broker',
          ...(payload?{'Content-Type':'application/json'}:{})},
        ...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(8000)});
      if(response.status!==(method==='POST'&&urlPath!=='/graphql'?201:200)||!response.body?.getReader)throw fail();
      const reader=response.body.getReader();const chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>256*1024){await reader.cancel();throw fail();}
        chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
      return {data:JSON.parse(Buffer.concat(chunks,size).toString('utf8')),link:response.headers.get('link')||''};
    }catch{throw fail();}
  }
  async function mint(m){
    try{
      const privateKey=createPrivateKey(await loadPrivateKey(m.appId));
      if(privateKey.asymmetricKeyType!=='rsa'||privateKey.asymmetricKeyDetails.modulusLength<2048)throw fail();
      const seconds=Math.floor(now()/1000);
      const encoded=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
      const message=encoded({alg:'RS256',typ:'JWT'})+'.'+encoded({iat:seconds-30,exp:seconds+300,iss:m.appId});
      const jwt=message+'.'+sign('RSA-SHA256',Buffer.from(message),privateKey).toString('base64url');
      const {data:app}=await request('/app',jwt);
      if(String(app.id)!==m.appId)throw fail();
      const {data:installation}=await request('/repos/'+m.repository+'/installation',jwt);
      if(String(installation.id)!==m.installationId||String(installation.app_id)!==m.appId||
         installation.suspended_at||!installation.permissions||
         !Object.keys(APPROVED).every(k=>APPROVED[k]==='write' ? installation.permissions[k]==='write' : ['read','write','admin'].includes(installation.permissions[k])))throw fail();
      const {data:issued}=await request('/app/installations/'+m.installationId+'/access_tokens',jwt,'POST',
        {repository_ids:[Number(m.repositoryNumericId)],permissions:APPROVED});
      const exp=Date.parse(issued.expires_at);
      if(typeof issued.token!=='string'||issued.token.length<20||issued.token.length>4096||/[\x00-\x20\x7f]/.test(issued.token)||
        !Number.isFinite(exp)||exp<=now()+60_000||exp>now()+3660000||
        !issued.permissions||Object.entries(issued.permissions).some(([k,v])=>APPROVED[k]!==v)||
        !Object.keys(APPROVED).every(k=>issued.permissions[k]===APPROVED[k])||
        !Array.isArray(issued.repositories)||issued.repositories.length!==1||
        String(issued.repositories[0].id)!==m.repositoryNumericId||issued.repositories[0].full_name!==m.repository)throw fail();
      const record={token:issued.token,expiresAt:exp};cache.set(m,record);return record;
    }catch{throw fail();}
  }
  async function token(m){
    const old=cache.get(m);if(old&&old.expiresAt>now()+60000)return old.token;
    if(!inflight.has(m))inflight.set(m,mint(m).finally(()=>inflight.delete(m)));
    return (await inflight.get(m)).token;
  }
  async function forScope(s){
    const m=map.get(s?.agentId+'\0'+s?.repository);
    if(!m||m.appId!==s.appId||m.installationId!==s.installationId)throw fail();
    const prefix='/repos/'+m.repository;
    const read=async suffix=>request(prefix+suffix,await token(m));
    const {data:repo}=await read('');
    if(String(repo.id)!==m.repositoryNumericId||repo.full_name!==m.repository||repo.archived||repo.disabled)throw fail();
    const validatePr=pr=>{
      if(!Number.isSafeInteger(pr?.number)||pr.number<1||
        pr.html_url!==`https://github.com/${m.repository}/pull/${pr.number}`||
        pr.head?.repo?.full_name!==m.repository||pr.base?.repo?.full_name!==m.repository||
        pr.head?.ref!==s.branch||pr.base?.ref!==s.base||pr.head?.sha!==s.headSha||
        pr.state!=='open'||typeof pr.draft!=='boolean')throw fail();
      return Object.freeze({number:pr.number,url:pr.html_url,headSha:pr.head.sha,draft:pr.draft,
        authorId:String(pr.user?.id),body:typeof pr.body==='string'?pr.body:''});
    };
    const publication={
      async findOpenPull(){
        if(!validRef(s.branch)||!validRef(s.base)||!SHA.test(s.headSha))throw fail();
        const q=new URLSearchParams({state:'all',head:m.repository.split('/')[0]+':'+s.branch,per_page:'100'});
        const {data,link}=await read('/pulls?'+q);
        if(link.includes('rel="next"')||!Array.isArray(data)||data.length>1)throw fail();
        return data.length?validatePr(data[0]):null;
      },
      async getPull(number){
        if(!Number.isSafeInteger(number)||number<1)throw fail();
        return validatePr((await read('/pulls/'+number)).data);
      },
      ...(allowPublication?{async createPull({title,body,draft,authorize}){
        if(typeof title!=='string'||title.length>200||typeof body!=='string'||body.length>12000||
          typeof draft!=='boolean'||typeof authorize!=='function'||!validRef(s.branch)||!validRef(s.base)||!SHA.test(s.headSha))throw fail();
        const credential=await token(m);
        await authorize();
        return validatePr((await request(prefix+'/pulls',credential,'POST',
          {title,body,head:s.branch,base:s.base,draft})).data);
      }}:{}),
    };
    return Object.freeze({
      ...(allowPublication||allowObservation?publication:{}),
      async branchHead(branch){
        if(!validRef(branch))throw fail();
        const {data}=await read('/git/ref/heads/'+branch.split('/').map(encodeURIComponent).join('/'));
        if(data.ref!=='refs/heads/'+branch||data.object?.type!=='commit'||!SHA.test(data.object.sha))throw fail();
        return data.object.sha;
      },
      async checks(head,required){
        if(!SHA.test(head)||!Array.isArray(required)||required.length<1||required.length>100||
           required.some(r=>!r||typeof r.name!=='string'||!ID.test(r.appId)))throw fail();
        const {data,link}=await read('/commits/'+head+'/check-runs?filter=latest&per_page=100');
        if(link.includes('rel="next"')||!Array.isArray(data.check_runs)||data.total_count!==data.check_runs.length||
           data.check_runs.length>100)throw fail();
        // Required checks are operator-configured name + issuing app, not
        // claimed by the agent. Ambiguous duplicates fail closed.
        return required.every(r=>{
          const hits=data.check_runs.filter(c=>c.name===r.name&&String(c.app?.id)===r.appId);
          return hits.length===1&&hits[0].head_sha===head&&hits[0].status==='completed'&&hits[0].conclusion==='success';
        });
      },
      mapping:Object.freeze({appId:m.appId,installationId:m.installationId,repository:m.repository}),
    });
  }
  // ABR-18: separate reviewer-only read facade; no coding scope, publication,
  // tokens, mutations or general-purpose GitHub URL access. Caller must supply
  // an operator-pinned reviewer App/installation/repository mapping.
  async function forReviewScope(s){
    if(!allowObservation||allowPublication||s?.agentId!=='chatgpt-review')throw fail();
    const m=map.get(s.agentId+'\0'+s.repository);
    if(!m||m.appId!==s.appId||m.installationId!==s.installationId)throw fail();
    const prefix='/repos/'+m.repository;
    const read=async suffix=>request(prefix+suffix,await token(m));
    const {data:repo}=await read('');
    if(String(repo.id)!==m.repositoryNumericId||repo.full_name!==m.repository||
       repo.archived||repo.disabled)throw fail();
    return Object.freeze({
      mapping:Object.freeze({repository:m.repository,appId:m.appId,installationId:m.installationId}),
      async observeReview(number,requiredChecks){
        if(!Number.isSafeInteger(number)||number<1||number>999999999||
           !Array.isArray(requiredChecks)||requiredChecks.length<1||requiredChecks.length>50||
           requiredChecks.some(r=>!r||typeof r.name!=='string'||r.name.length<1||
             r.name.length>128||!ID.test(r.appId)))throw fail();
        if(new Set(requiredChecks.map(r=>r.name+'\0'+r.appId)).size!==requiredChecks.length)throw fail();
        const fetchPr=async()=>{
          const {data:pr}=await read('/pulls/'+number);
          if(pr?.number!==number||
             pr.html_url!==`https://github.com/${m.repository}/pull/${number}`||
             !['open','closed'].includes(pr.state)||typeof pr.draft!=='boolean'||
             !SHA.test(pr.head?.sha)||!SHA.test(pr.base?.sha)||
             pr.head?.repo?.full_name!==m.repository||
             pr.base?.repo?.full_name!==m.repository||
             !validRef(pr.head?.ref)||!validRef(pr.base?.ref)||
             !/^[A-Za-z0-9-]{1,39}$/.test(pr.user?.login||''))throw fail();
          return pr;
        };
        const pr=await fetchPr();
        const head=pr.head.sha;
        const [{data:checks,link:checkLink},{data:reviews,link:reviewLink},{data:threadResult}]=await Promise.all([
          read('/commits/'+head+'/check-runs?filter=latest&per_page=100'),
          read('/pulls/'+number+'/reviews?per_page=100'),
          request('/graphql',await token(m),'POST',{query:`query ABR18VerifiedReviewThreads($owner:String!,$name:String!,$number:Int!) {
            repository(owner:$owner,name:$name) {
              nameWithOwner pullRequest(number:$number) {
                number headRefOid reviewThreads(first:100) {
                  pageInfo { hasNextPage }
                  nodes { isResolved isOutdated }
                }
              }
            }
          }`,variables:{owner:m.repository.split('/')[0],name:m.repository.split('/')[1],number}})
        ]);
        if(checkLink.includes('rel="next"')||reviewLink.includes('rel="next"')||
           !Array.isArray(checks?.check_runs)||checks.total_count!==checks.check_runs.length||
           checks.check_runs.length>100||!Array.isArray(reviews)||reviews.length>100||
           threadResult?.errors?.length||threadResult?.data?.repository?.nameWithOwner!==m.repository||
           threadResult.data.repository.pullRequest?.number!==number||
           threadResult.data.repository.pullRequest?.headRefOid!==head||
           threadResult.data.repository.pullRequest.reviewThreads?.pageInfo?.hasNextPage!==false||
           !Array.isArray(threadResult.data.repository.pullRequest.reviewThreads.nodes)||
           threadResult.data.repository.pullRequest.reviewThreads.nodes.length>100)throw fail();
        const nodes=threadResult.data.repository.pullRequest.reviewThreads.nodes;
        if(nodes.some(n=>typeof n?.isResolved!=='boolean'||typeof n?.isOutdated!=='boolean'))throw fail();
        const checked=requiredChecks.map(r=>{
          const hits=checks.check_runs.filter(c=>c.name===r.name&&String(c.app?.id)===r.appId);
          if(hits.length!==1||hits[0].head_sha!==head) return 'unknown';
          const c=hits[0];
          if(c.status!=='completed')return 'pending';
          return c.conclusion==='success'?'success':'failed';
        });
        const ci=checked.includes('failed')?'failed':
          checked.includes('unknown')?'unknown':
          checked.includes('pending')?'pending':'success';
        if(reviews.some(r=>!Number.isSafeInteger(r?.id)||r.id<1||
           !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(r.state)||
           (r.commit_id!==null&&!SHA.test(r.commit_id))))throw fail();
        const currentReviews=reviews.filter(r=>r.commit_id===head&&r.submitted_at&&
          ['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(r.state));
        const latestByActor=new Map();
        for(const r of currentReviews){
          if(!/^[A-Za-z0-9-]{1,39}$/.test(r.user?.login||'')||
             !Number.isFinite(Date.parse(r.submitted_at)))throw fail();
          const actor=r.user.login.toLowerCase(),previous=latestByActor.get(actor);
          if(!previous||Date.parse(r.submitted_at)>Date.parse(previous.submitted_at)||
             (r.submitted_at===previous.submitted_at&&r.id>previous.id)){
            latestByActor.set(actor,r);
          }
        }
        const changesRequested=[...latestByActor.values()].filter(r=>r.state==='CHANGES_REQUESTED').length;
        const unresolved=nodes.filter(n=>!n.isResolved).length;
        // Re-check the PR after independent requests; a push or closure in
        // flight cannot yield a review-ready snapshot for the old head.
        const again=await fetchPr();
        if(again.head.sha!==head||again.base.sha!==pr.base.sha||
           again.state!==pr.state||again.draft!==pr.draft)throw fail();
        return Object.freeze({
          schemaVersion:1,source:'github-app-readonly',repository:m.repository,
          repositoryNumericId:m.repositoryNumericId,installationId:m.installationId,
          pullNumber:number,headSha:head,baseSha:pr.base.sha,
          baseBranch:pr.base.ref,headBranch:pr.head.ref,authorLogin:pr.user.login,
          state:pr.state,draft:pr.draft,ciStatus:ci,
          requiredCheckCount:requiredChecks.length,
          reviewCount:currentReviews.length,changesRequestedReviews:changesRequested,
          unresolvedThreads:unresolved,outdatedThreads:nodes.filter(n=>n.isOutdated).length,
          totalThreads:nodes.length,observedAt:new Date(now()).toISOString(),
          // GitHub context readiness is NOT permission to dispatch. Linear
          // issue/PR linkage, reviewer identity, and a separate launch
          // acknowledgment are all independent trusted gates.
          githubContextReady:pr.state==='open'&&!pr.draft&&ci==='success'&&
            unresolved===0&&changesRequested===0,
          dispatchAuthorized:false,reviewLaunchStatus:'not_started',dispatched:false,
        });
      },
    });
  }
  return Object.freeze({forScope,forReviewScope});
}
