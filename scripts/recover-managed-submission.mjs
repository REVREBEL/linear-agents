#!/usr/bin/env node
// Offline operator entrypoint. Never invoke from an agent or workspace.
// Requires the reviewed root-owned host binding and an exact approval ID.
import { execFileSync } from 'node:child_process';
import { readFileSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { createJobStore } from '../jobs/persistence/job-store.mjs';
import { createReviewInbox } from '../bridge/orchestration/review-inbox.mjs';
import { loadManagedSubmissionHost,createManagedRecoveryService } from '../bridge/orchestration/managed-submission-service.mjs';

function serviceProperty(name){
  return execFileSync('/usr/bin/systemctl',['show','agent-bridge.service','--property='+name,'--value'],
    {encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin',LANG:'C'}}).trim();
}
function stopped(){
  try{return serviceProperty('ActiveState')==='inactive'&&serviceProperty('MainPID')==='0';}
  catch{return false;}
}
const deny=()=>Error('OFFLINE_SUBMISSION_RECOVERY_DENIED');
let recovery;
try{
  const [jobKey,approvalId,...rest]=process.argv.slice(2);
  if(rest.length||!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(jobKey||'')||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(approvalId||'')||!stopped())throw deny();
  const user=serviceProperty('User');
  const uid=Number(execFileSync('/usr/bin/id',['-u',user],{encoding:'utf8',timeout:3000}).trim());
  if(user!=='bridge'||!uid||process.getuid()!==uid)throw deny();
  const b=await loadManagedSubmissionHost();
  const repo=realpathSync(serviceProperty('WorkingDirectory'));
  const expectedJobs=realpathSync(path.join(repo,'linear-agent-bridge','linear-jobs'));
  if(b.jobsDir!==expectedJobs||typeof b.projectsRoot!=='string'||
    typeof b.routingConfigPath!=='string'||!path.isAbsolute(b.routingConfigPath)||
    typeof b.assertQuiescent!=='function'||!stopped())throw deny();
  // No secret, host path or provider receipt may come from CLI arguments.
  const binding={...b,assertQuiescent:job=>stopped()&&b.assertQuiescent(job)===true};
  recovery=createManagedRecoveryService({hostBinding:binding,jobStore:createJobStore(expectedJobs),
    jobsDir:expectedJobs,projectsRoot:b.projectsRoot,reviewInbox:createReviewInbox(expectedJobs),
    reviewRoutingConfig:JSON.parse(readFileSync(b.routingConfigPath,'utf8'))});
  const result=await recovery.recoverInterrupted(jobKey,approvalId);
  process.stdout.write(JSON.stringify(result)+'\n');
}catch{
  process.stderr.write('Offline recovery denied or observation incomplete. Inspect protected operator evidence. No provider mutation replayed.\n');
  process.exitCode=1;
}finally{recovery?.close();}
