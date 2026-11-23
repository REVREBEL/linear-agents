import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {prepareLocalAgentTask} from "./local-task-preparation.mjs";
async function fixture(run){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"abr59-m13-task-"));
  await fs.mkdir(path.join(root,".git","info"),{recursive:true});
  await fs.writeFile(path.join(root,".git","info","exclude"),"");
  const job={organizationId:"tenant",issueId:"ABR-59",payload:{data:{promptContext:"Fix the coding issue."}}};
  const route={repositoryRoot:root,launchDirectory:root,scopeKey:"project",
    projectId:"project-uuid",projectScope:"project"};
  const writes=[];
  const deps={job,route,agent:"qwen",jobKey:"job-1",safeJobId:"task-1",
    jobStore:{async transition(...args){writes.push(args);}},
    activeTaskMemory:{async update(root,issue,fn){return fn(null);}},
    drainProgressWrites:async()=>{},retrieveMemuMemory:async()=>"",
    extractDirectTask:x=>x,extractPromptContext:j=>j.payload?.data?.promptContext,
    logger:{log(){},warn(){}}};
  try{await run({deps,writes});}
  finally{await fs.rm(root,{recursive:true,force:true});}
}
test("task preparation injects lower-trust memory only with installed host hook",async()=>fixture(async({deps,writes})=>{
  const results=[];
  const {filename,routedJob}=await prepareLocalAgentTask({...deps,
    loadVerifiedMemoryReference:async r=>{results.push(r);
      return "[SCOPED VERIFIED MEMORY — LOWER-TRUST REFERENCE ONLY]\n1. Reviewed memory.\n[END SCOPED MEMORY REFERENCES]";}});
  const text=routedJob.payload.data.promptContext;
  assert.match(text,/Reviewed memory/);
  assert.ok(text.indexOf("Reviewed memory")<text.indexOf("Fix the coding issue."));
  assert.equal(results[0].tenantId,"tenant");
  assert.equal(results[0].agentId,"qwen");
  assert.equal(results[0].issueId,"ABR-59");
  assert.equal(results[0].jobKey,"job-1");
  assert.equal(JSON.parse(await fs.readFile(filename,"utf8")).payload.data.promptContext,text);
  assert.equal(writes.length,1);
  assert.equal(writes[0][1],"queued");
}));
test("disabled, failed or oversized reference never modifies prompt or stops dispatch",async()=>fixture(async({deps})=>{
  const normal=await prepareLocalAgentTask(deps);
  assert.equal(normal.routedJob.payload.data.promptContext,"Fix the coding issue.");
  for(const callback of [async()=>{throw Error("redacted");},async()=> "x".repeat(3001)]){
    const out=await prepareLocalAgentTask({...deps,loadVerifiedMemoryReference:callback});
    assert.equal(out.routedJob.payload.data.promptContext,"Fix the coding issue.");
  }
}));
