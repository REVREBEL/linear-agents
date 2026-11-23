import {createHash} from "node:crypto";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {createHostMemoryAuthority} from "./host-memory-authority.mjs";
import {createHostEvidenceClients} from "./host-evidence-clients.mjs";
import {createRestrictedMemuPersistence} from "./restricted-memu-persistence.mjs";
import {createTrustedGitSourceVerifier} from "./trusted-git-source.mjs";
import {verifiedRecallEnvelope,recallDigest} from "./scoped-recall.mjs";

const execFile=promisify(execFileCallback);
const KEYS=["tenantId","agentId","repositoryId","issueId"];
const SOURCE=/^docs\/verified-learnings\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:md|txt)$/;
const SHA=/^[0-9a-f]{40}$/;
const REPO=/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
function deny(){return Object.assign(new Error("Verified memory lifecycle denied"),{code:"EVERIFIED_MEMORY_DENIED"});}
function exactScope(a,b){return KEYS.every(k=>typeof a?.[k]==="string"&&a[k]===b?.[k]);}
function sourceDigest(source){return recallDigest(source);}

/**
 * Operator-side orchestration only. trustedJob, review policy and learning
 * path come from root-controlled activation; no model/HTTP/worker payload may
 * provide them. A completion notification is only a hint: stage(), commit()
 * and approve() each independently recheck the GitHub/Linear authority.
 */
export function createVerifiedMemoryLifecycle({
  trustedJob,policy,sourcePath,repositoryRoot,authorityRoot,
  makeClients=createHostEvidenceClients,
  makePersistence=createRestrictedMemuPersistence,
  makeAuthority=createHostMemoryAuthority,
  makeSourceVerifier=createTrustedGitSourceVerifier,
  readGit=async (root,sha,relative)=>{
    const {stdout}=await execFile("/usr/bin/git",["--no-pager","show",sha+":"+relative],{
      cwd:root,env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",GIT_CONFIG_NOSYSTEM:"1",
        GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1"},
      encoding:"buffer",timeout:5000,maxBuffer:2048});
    return stdout;
  },
  clock=()=>Date.now(),
  observer=()=>{},
}={}){
  const job=structuredClone(trustedJob),rules=structuredClone(policy);
  if(!job||typeof job.jobId!=="string"||!job.jobId||
     !REPO.test(job.scope?.repositoryId||"")||!KEYS.every(k=>typeof job.scope?.[k]==="string"&&job.scope[k])||
     !Number.isSafeInteger(job.prNumber)||job.prNumber<1||!SHA.test(job.headSha||"")||
     !SOURCE.test(sourcePath||"")||typeof repositoryRoot!=="string"||
     !repositoryRoot.startsWith("/")||typeof authorityRoot!=="string"||!authorityRoot.startsWith("/")||
     !Array.isArray(rules?.requiredChecks)||!rules.requiredChecks.length||
     !Array.isArray(rules?.allowedCheckApps)||!rules.allowedCheckApps.length||
     !Array.isArray(rules?.permittedReviewers)||!rules.permittedReviewers.length)throw deny();
  const sourceVerifier=makeSourceVerifier({repositories:{[job.scope.repositoryId]:repositoryRoot}});
  let setupPromise=null, promoting=false;
  async function setup(){
    if(!setupPromise)setupPromise=(async()=>{
      const [providers,persistence]=await Promise.all([
        makeClients({root:authorityRoot,job}),makePersistence({job})]);
      const authority=await makeAuthority({root:authorityRoot,job,policy:rules,
        github:providers.github,linear:providers.linear,
        verifySource:sourceVerifier,commitImpl:payload=>persistence.commit(payload)});
      return {authority,persistence,providers};
    })().catch(e=>{setupPromise=null;throw e;});
    return setupPromise;
  }
  async function pinnedSource(){
    const bytes=await readGit(repositoryRoot,job.headSha,sourcePath);
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>600)throw deny();
    const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    if(content!==content.trim()||/[\x00-\x1f\x7f]/.test(content))throw deny();
    const now=clock();
    if(!Number.isFinite(now))throw deny();
    const source={scope:job.scope,sourceGitSha:job.headSha,sourcePath,revision:1,
      expiresAt:new Date(now+7*86400000).toISOString(),content};
    if(verifiedRecallEnvelope({hits:[source]},{scope:job.scope,
      trustedDigests:new Set([sourceDigest(source)]),now}).entries.length!==1 ||
      await sourceVerifier({scope:source.scope,sourceGitSha:job.headSha,
        sourcePath,revision:1,content})!==true)throw deny();
    return source;
  }
  function emit(event){try{observer(event);}catch{/* diagnostic never authorizes */}}
  return Object.freeze({
    async promote({issueId,jobId}={}){
      if(issueId!==job.scope.issueId||jobId!==job.jobId||promoting)throw deny();
      promoting=true;
      let stage="source";
      try{
        const source=await pinnedSource(),{authority,providers}=await setup();
        stage="stage";
        await authority.stage(); // fresh GitHub review+CI; not the webhook
        const issue=await providers.linear.getIssue(job.scope.issueId);
        if(issue?.id!==job.scope.issueId||
           !(issue.status==="completed"||issue.statusType==="completed")||
           issue.repositoryId!==job.scope.repositoryId||issue.headSha!==job.headSha)throw deny();
        // A replay after fully confirmed approval is safe only if its source
        // is identical. Never re-run native commit on a partial outcome.
        stage="load";
        const previous=await authority.load();
        if(previous.approvedSources.size){
          const found=[...previous.approvedSources.values()].some(s=>
            exactScope(s.scope,source.scope)&&s.sourceGitSha===source.sourceGitSha&&
            s.sourcePath===source.sourcePath&&s.content===source.content);
          if(!found)throw deny();
          emit("already-confirmed");
          return {status:"already-confirmed"};
        }
        stage="commit";
        await authority.commit(source); // single irreversible claim
        stage="approve";
        await authority.approve(source); // signed only after confirmed marker
        emit("approved");
        return {status:"approved"};
      }catch{
        emit(stage==="commit"||stage==="approve"?"reconcile":"denied");
        throw deny();
      }finally{promoting=false;}
    },
    async recall({scope}={}){
      if(!exactScope(scope,job.scope))throw deny();
      try{
        const {authority,persistence}=await setup();
        const approved=await authority.load();
        if(!approved.approvedSources.size)return {schemaVersion:1,trust:"untrusted-reference-only",
          enabled:true,scope:{...job.scope},entries:[],text:""};
        const result=await persistence.recall(approved);
        if(!exactScope(result?.scope,job.scope)||result?.trust!=="untrusted-reference-only")throw deny();
        emit("recalled");
        return result;
      }catch{emit("read-denied");throw deny();}
    },
  });
}
