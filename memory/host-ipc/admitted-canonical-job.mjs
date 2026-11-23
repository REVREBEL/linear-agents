/** Read-only cross-check: a root pin is not itself an admitted Bridge job. */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";

const LEDGER="/home/bridge/agent-bridge/linear-agent-bridge/linear-jobs/job-state";
const STATES=new Set(["queued","launching","running","waiting_quota",
  "awaiting_external","completed"]);
async function jsonFile(filename){
  const h=await fs.open(filename,fs.constants.O_RDONLY|
    fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const st=await h.stat();
    if(!st.isFile()||st.size<2||st.size>131072)return null;
    return JSON.parse(await h.readFile("utf8"));
  }finally{await h.close();}
}
export async function admittedCanonicalJob(config,record,{read=jsonFile}={}){
  try{
    if(config?.ledgerRoot!==LEDGER)return false;
    const job=record.trustedJob,key=record.jobKey,scope=job.scope;
    if(typeof key!=="string"||!key||key.length>256)return false;
    const allowedRoot=Object.entries(config.repositories).filter(([,repo])=>
      repo===scope.repositoryId).map(([root])=>root);
    if(!allowedRoot.length)return false;
    const dirname=createHash("sha256").update(key).digest("hex");
    const ledger=await read(path.join(LEDGER,dirname,"state.json"));
    if(!ledger||ledger.key!==key||ledger.agent!==scope.agentId||
       ledger.jobId!==job.jobId||ledger.issueId!==scope.issueId||
       !STATES.has(ledger.state)||!allowedRoot.includes(ledger.repositoryRoot)||
       key!==ledger.agent+":"+ledger.deliveryId)return false;
    const filename=ledger.taskFile,root=ledger.repositoryRoot;
    if(typeof filename!=="string"||!filename.startsWith(root+"/.linear-agent/projects/")||
       !filename.endsWith(".json")||filename.includes("/../")||
       path.normalize(filename)!==filename)return false;
    const task=await read(filename),issue=task?.issueMetadata||{};
    return !!task&&task.organizationId===scope.tenantId&&
      (task.issueId||issue.id)===scope.issueId&&
      (task.agentSessionId==null||task.agentSessionId===ledger.agentSessionId);
  }catch{return false;}
}
