import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {admittedCanonicalJob} from "./admitted-canonical-job.mjs";
const root="/home/bridge/agent-bridge";
const ledgerRoot=root+"/linear-agent-bridge/linear-jobs/job-state";
const key="qwen:delivery-test",issue="ABR-59";
const record={jobKey:key,trustedJob:{jobId:"delivery-test",scope:{
  tenantId:"tenant",agentId:"qwen",repositoryId:"REVREBEL/linear-agents",issueId:issue}}};
const config={ledgerRoot,repositories:{[root]:"REVREBEL/linear-agents"}};
const dir=ledgerRoot+"/"+createHash("sha256").update(key).digest("hex")+"/state.json";
const task=root+"/.linear-agent/projects/demo/inbox/delivery-test.json";
const state={key,agent:"qwen",deliveryId:"delivery-test",jobId:"delivery-test",
  state:"completed",issueId:issue,repositoryRoot:root,taskFile:task,agentSessionId:"session"};
const payload={organizationId:"tenant",issueId:issue,agentSessionId:"session"};
function fixture(l=state,p=payload){
  return {read:async filename=>{
    assert.ok([dir,task].includes(filename));
    return structuredClone(filename===dir?l:p);
  }};
}
test("exact canonical admission and scoped task are required",async()=>{
  assert.equal(await admittedCanonicalJob(config,record,fixture()),true);
  for(const change of [
    x=>x.key="not-original",x=>x.agent="other",x=>x.jobId="forged",
    x=>x.state="failed",x=>x.issueId="ABR-60",
    x=>x.repositoryRoot="/tmp/unmapped",x=>x.deliveryId="other",
    x=>x.taskFile="/etc/passwd",x=>x.taskFile=root+"/.linear-agent/projects/x/../evil.json",
  ]){
    const l=structuredClone(state);change(l);
    assert.equal(await admittedCanonicalJob(config,record,fixture(l)),false);
  }
  for(const change of [x=>x.organizationId="foreign",x=>x.issueId="ABR-60",
    x=>x.agentSessionId="wrong"]){
    const p=structuredClone(payload);change(p);
    assert.equal(await admittedCanonicalJob(config,record,fixture(state,p)),false);
  }
  assert.equal(await admittedCanonicalJob({...config,ledgerRoot:"/tmp"},record,fixture()),false);
});
