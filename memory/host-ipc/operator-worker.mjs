/** M14 operator-only child. It never accepts a scope, PR, source, policy or
 * credential from IPC. The key indexes the root-owned activation manifest. */
import path from "node:path";
import fs from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {readOperatorFile} from "../host-memory-authority.mjs";
import {trustedPath} from "../restricted-memu-persistence.mjs";
import {createVerifiedMemoryLifecycle} from "../verified-memory-lifecycle.mjs";
import {selectPinnedMemoryJob} from "./activation-contract.mjs";

const ROOT="/var/lib/bridge-memory-authority";
const CODE="/var/lib/bridge-memory-authority-code";
const KEYS=/^[A-Za-z0-9._:-]{1,256}$/;
const SHA=/^[0-9a-f]{40}$/;
function deny(){throw Error("memory operator denied");}
async function main(){
  if(process.getuid?.()!==0||process.argv.length!==4)deny();
  const [, ,op,jobKey]=process.argv;
  if(!["recall","promote"].includes(op)||!KEYS.test(jobKey))deny();
  await trustedPath(process.execPath,"file");
  await trustedPath(CODE,"directory");
  await trustedPath(path.join(CODE,"memory/host-ipc/operator-worker.mjs"),"file");
  const config=JSON.parse((await readOperatorFile(ROOT,"activation.json",16384)).toString("utf8"));
  if(config?.schemaVersion!==1||config.activation!==true||!SHA.test(config.releaseSha)||
    !Array.isArray(config.jobs)||config.jobs.length>32||!config.jobs.length)deny();
  const selected=config.jobs.filter(j=>j?.jobKey===jobKey);
  if(selected.length!==1)deny();
  const [record]=selected;
  if(!config.repositories||!Object.values(config.repositories).includes(record.trustedJob?.scope?.repositoryId))deny();
  const head=execFileSync("/usr/bin/git",["rev-parse","HEAD"],{cwd:CODE,encoding:"utf8",
    env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",GIT_CONFIG_NOSYSTEM:"1",
      GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1"},timeout:3000,maxBuffer:256}).trim();
  if(head!==config.releaseSha)deny();
  const lifecycle=createVerifiedMemoryLifecycle({trustedJob:record.trustedJob,
    policy:record.policy,sourcePath:record.sourcePath,repositoryRoot:CODE,
    authorityRoot:ROOT,observer:()=>{}});
  const result=op==="recall"
    ? await lifecycle.recall({scope:record.trustedJob.scope})
    : await lifecycle.promote({issueId:record.trustedJob.scope.issueId,
      jobId:record.trustedJob.jobId});
  const bytes=JSON.stringify(result);
  if(Buffer.byteLength(bytes)>11000)deny();
  process.stdout.write(bytes+"\n");
}
main().catch(()=>{console.error("memory operator denied");process.exitCode=1;});
