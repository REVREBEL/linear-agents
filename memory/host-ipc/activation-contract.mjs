/** Review-pinned M14 job selection. This is NOT a configuration discovery API.
 * All inputs are operator-owned, loaded from root-private activation.json. */
const KEY=/^[A-Za-z0-9._:-]{1,256}$/;
const SHA=/^[0-9a-f]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE=/^docs\/verified-learnings\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:txt|md)$/;
const SCOPE=["tenantId","agentId","repositoryId","issueId"];
function deny(){throw Error("memory activation refused");}
export function selectPinnedMemoryJob(config,operation,jobKey){
  if(!["recall","promote"].includes(operation)||!KEY.test(jobKey||"")||
     config?.schemaVersion!==1||config.activation!==true||
     !SHA.test(config.releaseSha||"")||
     !config.sourceCheckouts||typeof config.sourceCheckouts!=="object"||
     !config.ledgerRoot||!config.repositories||typeof config.repositories!=="object"||
     Array.isArray(config.repositories)||!Object.keys(config.repositories).length||
     !Array.isArray(config.jobs)||config.jobs.length<1||config.jobs.length>32)deny();
  const known=new Set();
  for(const [root,repo] of Object.entries(config.repositories)){
    if(!root.startsWith("/")||root.includes("..")||!REPO.test(repo||""))deny();
    known.add(repo);
  }
  if(Object.keys(config.sourceCheckouts).sort().join(",")!==[...known].sort().join(",")||
     config.ledgerRoot!=="/home/bridge/agent-bridge/linear-agent-bridge/linear-jobs/job-state")deny();
  for(const source of Object.values(config.sourceCheckouts)){
    if(!source||typeof source!=="object"||Object.keys(source).sort().join(",")!=="headSha,root"||
       typeof source.root!=="string"||!source.root.startsWith("/var/lib/bridge-memory-sources/")||
       source.root.includes("..")||!SHA.test(source.headSha||""))deny();
  }
  const keys=new Set();
  for(const j of config.jobs){
    if(!j||!KEY.test(j.jobKey||"")||keys.has(j.jobKey))deny();
    keys.add(j.jobKey);
  }
  const selected=config.jobs.filter(j=>j.jobKey===jobKey);
  if(selected.length!==1)deny();
  const entry=selected[0],job=entry.trustedJob,scope=job?.scope,policy=entry.policy;
  if(!job||typeof job.jobId!=="string"||!KEY.test(job.jobId)||
     !Number.isSafeInteger(job.prNumber)||job.prNumber<=0||!SHA.test(job.headSha||"")||
     !scope||Object.keys(scope).sort().join(",")!==SCOPE.slice().sort().join(",")||
     !SCOPE.every(key=>typeof scope[key]==="string"&&scope[key].length>0&&scope[key].length<=128)||
     !known.has(scope.repositoryId)||!SOURCE.test(entry.sourcePath||"")||
     entry.sourcePath.includes("//")||entry.sourcePath.includes("..")||
     !policy||Object.keys(policy).sort().join(",")!==
       ["requiredChecks","allowedCheckApps","permittedReviewers"].sort().join(",")||
     !Object.values(policy).every(v=>Array.isArray(v)&&v.length>0&&v.length<=30&&
       v.every(x=>typeof x==="string"&&x.length>0&&x.length<=128)))deny();
  return structuredClone(entry);
}
