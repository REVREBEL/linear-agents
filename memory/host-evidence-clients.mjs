import { createSign } from "node:crypto";
import { readOperatorFile } from "./host-memory-authority.mjs";
import { createGitHubReviewClient } from "./github-review-client.mjs";
import { createLinearCompletionClient } from "./linear-completion-client.mjs";

const REPO=/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenOk=t=>typeof t==="string" && t.length>=12 && t.length<=4096 && !/[\x00-\x20\x7f]/.test(t);
const int=n=>Number.isSafeInteger(n)&&n>0;
const permissions={metadata:"read",pull_requests:"read",checks:"read",contents:"read"};
function deny(){return Object.assign(new Error("Pinned host evidence credentials unavailable or rejected"),{code:"EHOST_EVIDENCE_DENIED"});}
async function jsonRequest(fetchImpl,url,credential,body,expected=200){
  try {
    const response=await fetchImpl(url,{method:body?"POST":"GET",redirect:"error",
      headers:{Authorization:"Bearer "+credential,Accept:"application/vnd.github+json",
        "Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"REVREBEL-Bridge-Authority"},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
    if(response.status!==expected||typeof response.body?.getReader!=="function") throw deny();
    const reader=response.body.getReader(), chunks=[];let n=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;
        n+=value.byteLength;if(n>262144){await reader.cancel();throw deny();}chunks.push(Buffer.from(value));}
    } finally {reader.releaseLock();}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,n)));
  } catch {throw deny();}
}
function validateConfig(c,job){
  if(!c||!REPO.test(c.repositoryId||"")||job.scope?.repositoryId!==c.repositoryId||
    !int(c.repositoryNumericId)||!int(c.githubAppId)||!int(c.installationId)||
    !UUID.test(c.linearWorkspaceId||"")||!UUID.test(c.linearActorId||"")||
    !UUID.test(c.linearTeamId||"")||job.scope.tenantId!==c.linearWorkspaceId)throw deny();
}
function jwtFor(appId,pem){
  const now=Math.floor(Date.now()/1000), enc=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
  const data=enc({alg:"RS256",typ:"JWT"})+"."+enc({iat:now-60,exp:now+480,iss:String(appId)});
  return data+"."+createSign("RSA-SHA256").update(data).sign(pem).toString("base64url");
}
/** Operator provisions credentials directly in a private root. No inherited
 * environment, CLI fallback, agent-owned PEM, token printing or arbitrary URLs.
 * The only POSTs mint a repository-limited read-only token or query Linear. */
export async function createHostEvidenceClients({root,job,fetchImpl=fetch}={}){
  try {
    job=structuredClone(job);
    const config=JSON.parse((await readOperatorFile(root,"evidence.json",16384)).toString("utf8"));
    validateConfig(config,job);
    const gh="https://api.github.com";
    let activeToken=null, activeUntil=0, pending;
    async function mint(){
      const pem=await readOperatorFile(root,"github-app.pem",16384);
      let jwt;
      try { jwt=jwtFor(config.githubAppId,pem); } finally { pem.fill(0); }
      const installation=await jsonRequest(fetchImpl,gh+"/repos/"+config.repositoryId+"/installation",jwt);
      if(installation.id!==config.installationId||installation.app_id!==config.githubAppId||
          installation.account?.login!==config.repositoryId.split("/")[0]||installation.suspended_at!==null)throw deny();
      const result=await jsonRequest(fetchImpl,gh+"/app/installations/"+config.installationId+"/access_tokens",jwt,
        {repository_ids:[config.repositoryNumericId],permissions},201);
      const expiry=Date.parse(result.expires_at);
      if(!tokenOk(result.token)||!Number.isFinite(expiry)||expiry<=Date.now()+60000||
        !result.permissions||Object.values(result.permissions).some(p=>p!=="read")||
        Object.keys(permissions).some(p=>result.permissions[p]!=="read"))throw deny();
      const available=await jsonRequest(fetchImpl,gh+"/installation/repositories?per_page=100",result.token);
      if(available.total_count!==1||available.repositories?.length!==1||
        available.repositories[0].id!==config.repositoryNumericId||
        available.repositories[0].full_name!==config.repositoryId)throw deny();
      activeToken=result.token;activeUntil=expiry;
      return activeToken;
    }
    async function githubToken(){
      if(activeToken&&activeUntil>Date.now()+60000)return activeToken;
      if(!pending)pending=mint().finally(()=>{pending=null;});
      return pending;
    }
    async function linearToken(){
      const token=(await readOperatorFile(root,"linear-oauth.token",4096)).toString("utf8").trim();
      if(!tokenOk(token))throw deny();
      const v=await jsonRequest(fetchImpl,"https://api.linear.app/graphql",token,
        {query:"query BridgeAuthorityIdentity { viewer { id } organization { id } }"});
      if(v.errors?.length||v.data?.viewer?.id!==config.linearActorId||
        v.data?.organization?.id!==config.linearWorkspaceId)throw deny();
      return token;
    }
    // Narrow the adapter to one pinned repository even for an erroneous call.
    const client=createGitHubReviewClient({tokenProvider:githubToken,fetchImpl});
    const github=Object.freeze(Object.fromEntries(["getPullRequest","listReviews","listCheckRuns","getCollaboratorPermission"].map(name=>
      [name,(repository,...args)=>{if(repository!==config.repositoryId)throw deny();return client[name](repository,...args);}])));
    const clientLinear=createLinearCompletionClient({tokenProvider:linearToken,teamId:config.linearTeamId,github,
      repositoryId:config.repositoryId,prNumber:job.prNumber,headSha:job.headSha,fetchImpl});
    const linear=Object.freeze({getIssue(id){if(id!==job.scope.issueId)throw deny();return clientLinear.getIssue(id);}});
    return Object.freeze({github,linear});
  } catch {throw deny();}
}
