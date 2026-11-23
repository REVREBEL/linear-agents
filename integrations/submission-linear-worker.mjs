// ABR-17 M3: fixed-endpoint, host-only Linear and Worker adapters.
// All mapping and tokens come from trusted host configuration. No token
// is persisted in the coordinator journal or returned to a runner.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const deny=()=>Error('SUBMISSION_PROVIDER_VERIFICATION_FAILED');
const tokenOK=t=>typeof t==='string'&&t.length>=12&&t.length<=4096&&!/[\x00-\x20\x7f]/.test(t);
async function jsonRequest(fetchImpl,url,token,payload){
  try{
    if(!tokenOK(token))throw deny();
    const response=await fetchImpl(url,{method:'POST',redirect:'error',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    if(response.status!==200||!response.body?.getReader)throw deny();
    const reader=response.body.getReader();let bytes=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;if(bytes>262144){await reader.cancel();throw deny();}
      chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
    if(!result||typeof result!=='object'||result.errors?.length)throw deny();
    return result;
  }catch{throw deny();}
}
const marker=c=>'[bridge-submission:'+c.operationId+']';
const bodyFor=c=>['Bridge verified submission',c.github.url,'Head: '+c.scope.headSha,
  'Required configured checks: passed at publication.',
  'Agent summary (descriptive): '+c.summary.replace(/[<>\[\]]/g,' '),marker(c)].join('\n\n');
export function createSubmissionLinearWorker({mappings,loadLinearToken,loadWorkerSecret,
  fetchImpl=fetch}={}){
  if(!Array.isArray(mappings)||typeof loadLinearToken!=='function'||
    typeof loadWorkerSecret!=='function'||typeof fetchImpl!=='function')throw deny();
  const map=new Map();
  for(const entry of mappings){
    if(!entry||typeof entry.agentId!=='string'||typeof entry.tenantId!=='string'||
      ![entry.organizationId,entry.teamId,entry.actorId,entry.inReviewStateId].every(x=>UUID.test(x||''))||
      !Array.isArray(entry.allowedSourceStateIds)||!entry.allowedSourceStateIds.length||
      !entry.allowedSourceStateIds.every(x=>UUID.test(x))||
      typeof entry.workerUrl!=='string')throw deny();
    const u=new URL(entry.workerUrl);
    if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||
      u.pathname!=='/complete'||!/^linear-[a-z0-9-]+\.revrebel\.io$/.test(u.hostname))throw deny();
    const key=entry.tenantId+'\0'+entry.agentId;
    if(map.has(key))throw deny();
    map.set(key,Object.freeze({...entry,allowedSourceStateIds:Object.freeze([...entry.allowedSourceStateIds])}));
  }
  async function bind(c){
    const s=c.scope,m=map.get(s.tenantId+'\0'+s.agentId);
    if(!m||!HASH.test(c.operationId)||typeof c.authorize!=='function')throw deny();
    const token=await loadLinearToken(m);
    const query=async(query,variables,mutation=false)=>{
      if(mutation)await c.authorize();
      return (await jsonRequest(fetchImpl,'https://api.linear.app/graphql',token,{query,variables})).data;
    };
    const identity=await query('query SubmissionIdentity { viewer { id } organization { id } }',{});
    if(identity?.viewer?.id!==m.actorId||identity?.organization?.id!==m.organizationId)throw deny();
    async function issue(){
      const {issue:p}=await query('query SubmissionIssue($id:String!){issue(id:$id){id identifier archivedAt team{id} state{id name type}}}',{id:s.issueUuid});
      if(p?.id!==s.issueUuid||p.identifier!==s.issueIdentifier||p.team?.id!==m.teamId||
         p.archivedAt!==null||!p.state||['completed','canceled'].includes(p.state.type)||
         !(p.state.id===m.inReviewStateId||m.allowedSourceStateIds.includes(p.state.id)))throw deny();
      return p;
    }
    async function findComment(){
      let after=null;const found=[],seen=new Set();
      for(let page=0;page<10;page++){
        const result=await query('query SubmissionComments($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body user{id}} pageInfo{hasNextPage endCursor}}}}',{id:s.issueUuid,after});
        const rows=result?.issue?.comments;
        if(result?.issue?.id!==s.issueUuid||!Array.isArray(rows?.nodes)||rows.nodes.length>100||
          typeof rows.pageInfo?.hasNextPage!=='boolean')throw deny();
        for(const row of rows.nodes)if(row.body?.includes(marker(c)))found.push(row);
        if(!rows.pageInfo.hasNextPage){
          if(found.length>1||found.some(x=>x.user?.id!==m.actorId||x.body!==bodyFor(c)||!UUID.test(x.id)))throw deny();
          return found[0]||null;
        }
        after=rows.pageInfo.endCursor;
        if(typeof after!=='string'||!after||seen.has(after))throw deny();seen.add(after);
      }throw deny();
    }
    const commentReceipt=row=>({verified:true,issueUuid:s.issueUuid,commentId:row.id,headSha:s.headSha,agentId:s.agentId});
    const stateReceipt=p=>{
      if(p.state.id!==m.inReviewStateId||p.state.name!=='In Review'||p.state.type!=='started')throw deny();
      return {verified:true,issueUuid:s.issueUuid,state:'In Review',agentId:s.agentId};
    };
    function activityBody(status){
      return (status==='completed'?'Work submitted for review.':
        'Work halted without publication: '+c.summary.replace(/[<>\[\]]/g,' '))+'\n'+marker(c);
    }
    async function readTerminalSession(status){
      const terminal=status==='completed'?'complete':'error';
      const typename=status==='completed'?'AgentActivityResponseContent':'AgentActivityErrorContent';
      let after=null,last=null,matched=0;const seen=new Set(),seenActivities=new Set();
      for(let page=0;page<10;page++){
        const r=await query(`query SubmissionSession($id:String!,$after:String){
          agentSession(id:$id){id status archivedAt appUser{id} issue{id}
            activities(first:100,after:$after){nodes{id createdAt archivedAt ephemeral signal user{id}
              content{__typename ... on AgentActivityResponseContent{body}
                ... on AgentActivityErrorContent{body}}}
              pageInfo{hasNextPage endCursor}}}}`,{id:s.sessionId,after});
        const session=r?.agentSession,rows=session?.activities;
        if(session?.id!==s.sessionId||session.appUser?.id!==m.actorId||
          session.issue?.id!==s.issueUuid||session.archivedAt!==null||session.status!==terminal||
          !Array.isArray(rows?.nodes)||rows.nodes.length>100||typeof rows.pageInfo?.hasNextPage!=='boolean')throw deny();
        for(const a of rows.nodes){
          if(!UUID.test(a.id)||seenActivities.has(a.id)||!Number.isFinite(Date.parse(a.createdAt)))throw deny();
          seenActivities.add(a.id);
          if(a.archivedAt!==null)continue;
          const time=Date.parse(a.createdAt);
          if(!last||time>last.time)last={id:a.id,time};
          else if(time===last.time)throw deny();
          if(a.content?.body?.includes(marker(c))){
            if(a.user?.id!==m.actorId||a.content.__typename!==typename||
              a.content.body!==activityBody(status)||a.ephemeral!==false||a.signal!==null)throw deny();
            matched++;
          }
        }
        if(!rows.pageInfo.hasNextPage){
          // Require exact single terminal activity rather than just a
          // previously completed turn in a restarted or reprompted session.
          if(matched!==1||!last)throw deny();
          const r2=await query(`query SubmissionSessionLatest($id:String!){
            agentSession(id:$id){id status archivedAt appUser{id} issue{id}
              activities(first:1){nodes{id createdAt archivedAt ephemeral signal user{id}
                content{__typename ... on AgentActivityResponseContent{body}
                  ... on AgentActivityErrorContent{body}}} pageInfo{hasNextPage}}}}`,{id:s.sessionId});
          const current=r2?.agentSession;
          const final=current?.activities?.nodes?.[0];
          if(current?.id!==s.sessionId||current.appUser?.id!==m.actorId||
            current.issue?.id!==s.issueUuid||current.archivedAt!==null||
            current.status!==terminal||final?.id!==last.id||
            final?.user?.id!==m.actorId||final?.content?.__typename!==typename||
            final?.content?.body!==activityBody(status)||final?.archivedAt!==null||
            final?.signal!==null||final?.ephemeral!==false)throw deny();
          return {sessionId:s.sessionId,organizationId:m.organizationId,actorId:m.actorId,
            operationId:c.operationId,status,terminal:true};
        }
        after=rows.pageInfo.endCursor;
        if(typeof after!=='string'||!after||seen.has(after))throw deny();seen.add(after);
      }throw deny();
    }
    async function observe(status){
      const o=await readTerminalSession(status);
      if(!o||o.sessionId!==s.sessionId||o.organizationId!==m.organizationId||
        o.actorId!==m.actorId||o.operationId!==c.operationId||o.status!==status||
        o.terminal!==true)throw deny();
      return {verified:true,sessionId:s.sessionId,status,agentId:s.agentId};
    }
    async function close(status){
      const current=await issue();
      if(status==='completed')stateReceipt(current);
      else if(current.state.id===m.inReviewStateId)throw deny();
      const sessionData=await query('query SubmissionSessionScope($id:String!){agentSession(id:$id){id status archivedAt appUser{id} issue{id}}}',{id:s.sessionId});
      const session=sessionData?.agentSession;
      if(session?.id!==s.sessionId||session.appUser?.id!==m.actorId||
        session.issue?.id!==s.issueUuid||session.archivedAt!==null||
        !['active','pending','awaitingInput'].includes(session.status))throw deny();
      const secret=await loadWorkerSecret(m);
      const activityType=status==='completed'?'response':'error';
      await c.authorize();
      const r=await jsonRequest(fetchImpl,m.workerUrl,secret,{
        agentSessionId:s.sessionId,organizationId:m.organizationId,status,activityType,
        body:activityBody(status)});
      if(r.ok!==true||r.agentSessionId!==s.sessionId||r.organizationId!==m.organizationId||
        r.activityType!==activityType)throw deny();
      // Worker ACK is not verified terminal session state. Independent
      // observer must see the exact operation/activity and terminal status.
      return observe(status);
    }
    return {
      async postLinear(){
        await issue();let row=await findComment();
        if(!row){
          const r=await query('mutation SubmissionComment($input:CommentCreateInput!){commentCreate(input:$input){success comment{id}}}',{input:{issueId:s.issueUuid,body:bodyFor(c)}},true);
          if(r?.commentCreate?.success!==true||!UUID.test(r.commentCreate.comment?.id))throw deny();
          row=await findComment();
          if(row?.id!==r.commentCreate.comment.id)throw deny();
        }
        return commentReceipt(row);
      },
      async observeComment(){await issue();const row=await findComment();if(!row)throw deny();return commentReceipt(row);},
      async moveInReview(){
        const current=await issue();
        if(current.state.id!==m.inReviewStateId){
          const target=await query('query SubmissionTarget($id:String!){workflowState(id:$id){id name type team{id}}}',{id:m.inReviewStateId});
          const w=target?.workflowState;
          if(w?.id!==m.inReviewStateId||w.name!=='In Review'||w.type!=='started'||w.team?.id!==m.teamId)throw deny();
          await issue();
          const r=await query('mutation SubmissionState($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id}}}',{id:s.issueUuid,input:{stateId:m.inReviewStateId}},true);
          if(r?.issueUpdate?.success!==true||r.issueUpdate.issue?.id!==s.issueUuid)throw deny();
        }
        return stateReceipt(await issue());
      },
      async observeReview(){return stateReceipt(await issue());},
      close,observe,
    };
  }
  return Object.freeze({
    postLinear:async c=>(await bind(c)).postLinear(),
    observeComment:async c=>(await bind(c)).observeComment(),
    moveInReview:async c=>(await bind(c)).moveInReview(),
    observeReview:async c=>(await bind(c)).observeReview(),
    closeSession:async c=>(await bind(c)).close('completed'),
    closeFailedSession:async c=>(await bind(c)).close('failed'),
    observeSession:async(c,status)=>(await bind(c)).observe(status),
  });
}
