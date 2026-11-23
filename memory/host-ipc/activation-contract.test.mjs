import test from "node:test";
import assert from "node:assert/strict";
import {selectPinnedMemoryJob} from "./activation-contract.mjs";

const job={jobId:"approved-job",scope:{
  tenantId:"tenant",agentId:"qwen",repositoryId:"REVREBEL/linear-agents",issueId:"ABR-59"},
  prNumber:276,headSha:"a".repeat(40)};
const record={jobKey:"qwen:delivery",trustedJob:job,
  policy:{requiredChecks:["verify"],allowedCheckApps:["github-actions"],
    permittedReviewers:["independent"]},
  sourcePath:"docs/verified-learnings/approved.md"};
function manifest(){return {schemaVersion:1,activation:true,releaseSha:"b".repeat(40),
  repositories:{"/home/bridge/agent-bridge":"REVREBEL/linear-agents"},jobs:[structuredClone(record)]};}
test("pins operator-approved job and isolates caller return object",()=>{
  const result=selectPinnedMemoryJob(manifest(),"recall","qwen:delivery");
  assert.deepEqual(result,record);
  result.trustedJob.scope.issueId="forged";
  assert.equal(record.trustedJob.scope.issueId,"ABR-59");
});
test("rejects invented job, rejected release, duplicate bindings and foreign scope",()=>{
  for(const change of [
    m=>m.activation=false,
    m=>m.releaseSha="unknown",
    m=>m.repositories={"/tmp/repo":"bad repository"},
    m=>m.jobs.push(structuredClone(m.jobs[0])),
    m=>m.jobs[0].trustedJob.scope.repositoryId="REVREBEL/foreign",
    m=>m.jobs[0].trustedJob.scope.agentId="",
    m=>m.jobs[0].trustedJob.headSha="unverified",
    m=>m.jobs[0].sourcePath="../secrets",
    m=>m.jobs[0].sourcePath="docs/verified-learnings/../../secret.md",
    m=>m.jobs[0].policy.requiredChecks=[],
  ]){
    const m=manifest();change(m);
    assert.throws(()=>selectPinnedMemoryJob(m,"recall","qwen:delivery"),/refused/);
  }
  assert.throws(()=>selectPinnedMemoryJob(manifest(),"recall","another:job"),/refused/);
  assert.throws(()=>selectPinnedMemoryJob(manifest(),"execute","qwen:delivery"),/refused/);
});
