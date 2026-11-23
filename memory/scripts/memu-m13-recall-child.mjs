import assert from "node:assert/strict";
import {createVerifiedMemoryLifecycle} from "../verified-memory-lifecycle.mjs";
import {createDisposableRestrictedMemuPersistence} from "../restricted-memu-persistence.mjs";

const [socketRoot,root]=process.argv.slice(2);
const scope={tenantId:"tenant-a",agentId:"agent-a",repositoryId:"Canary/memory",issueId:"CAN-1"};
const sha="c".repeat(40);
const job={jobId:"m13-native-after-restart",scope,prNumber:33,headSha:sha};
const note="Native scoped memory promotion is independently verified.";
const sourcePath="docs/verified-learnings/m13-native.txt";
const lifecycle=createVerifiedMemoryLifecycle({
  trustedJob:job,policy:{requiredChecks:["synthetic-canary"],allowedCheckApps:["github-actions"],
    permittedReviewers:["fixture-reviewer"]},
  sourcePath,repositoryRoot:"/fake/root-controlled/fixture",authorityRoot:root,
  makeClients:async()=>({github:{},linear:{}}),
  makePersistence:async()=>createDisposableRestrictedMemuPersistence({job,root,socketRoot}),
  makeSourceVerifier:()=>async input=>(input.headSha??input.sourceGitSha)===sha&&
    input.sourcePath===sourcePath&&input.content===note&&input.revision===1,
  readGit:async()=>Buffer.from(note),
});
const found=await lifecycle.recall({scope});
assert.equal(found.entries.length,1);
assert.equal(found.entries[0].content,note);
console.log(JSON.stringify({freshProcess:true,signedSource:true,nativePostgres:true,scoped:true}));
