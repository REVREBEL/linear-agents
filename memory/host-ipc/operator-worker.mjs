/** Root-only, immutable operator entrypoint. Local application imports occur
 * only AFTER validating the entire executable checkout and release SHA. */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";

const ROOT="/var/lib/bridge-memory-authority";
const CODE="/var/lib/bridge-memory-authority-code";
const KEY=/^[A-Za-z0-9._:-]{1,256}$/;
const SHA=/^[0-9a-f]{40}$/;
const SHA256=/^[0-9a-f]{64}$/;
const GIT_ENV={PATH:"/usr/bin:/bin",HOME:"/nonexistent",
  GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",
  GIT_OPTIONAL_LOCKS:"0",GIT_NO_REPLACE_OBJECTS:"1"};
function deny(){throw Error("memory operator denied");}
async function secureDirectory(root){
  if(!path.isAbsolute(root)||path.normalize(root)!==root)deny();
  for(let current=root;;current=path.dirname(current)){
    const st=await fs.lstat(current);
    if(st.uid!==0||!st.isDirectory()||(st.mode&0o022))deny();
    if(current==="/")break;
  }
  let checked=0;
  async function walk(directory){
    for(const name of await fs.readdir(directory)){
      const file=path.join(directory,name),st=await fs.lstat(file);
      if(++checked>60000||st.uid!==0||(st.mode&0o022)||
         (!st.isDirectory()&&!st.isFile()))deny();
      if(st.isDirectory())await walk(file);
    }
  }
  await walk(root);
  if(!checked)deny();
}
function git(root,args){
  return execFileSync("/usr/bin/git",args,{cwd:root,env:GIT_ENV,
    encoding:"utf8",maxBuffer:262144,timeout:8000}).trim();
}
async function reviewedRoot(root,sha){
  if(!SHA.test(sha||""))deny();
  await secureDirectory(root);
  if(git(root,["rev-parse","HEAD"])!==sha||
     git(root,["rev-parse","--show-toplevel"])!==root||
     git(root,["status","--porcelain=v1","--untracked-files=all"])||
     git(root,["ls-files","--others","--ignored","--exclude-standard"]))deny();
}
async function manifestFor(digest){
  await secureDirectory(ROOT);
  const h=await fs.open(path.join(ROOT,"activation.json"),
    fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const st=await h.stat();
    if(!st.isFile()||st.uid!==0||(st.mode&0o777)!==0o600||st.size>16384)deny();
    const data=await h.readFile();
    if(!data.length||data.length>16384||
       createHash("sha256").update(data).digest("hex")!==digest)deny();
    return JSON.parse(data.toString("utf8"));
  }finally{await h.close();}
}
async function main(){
  if(process.getuid?.()!==0||process.argv.length!==5)deny();
  const [, ,operation,jobKey,digest]=process.argv;
  if(!["recall","promote"].includes(operation)||!KEY.test(jobKey)||!SHA256.test(digest))deny();
  const config=await manifestFor(digest);
  if(config?.activation!==true||config.schemaVersion!==1)deny();
  await reviewedRoot(CODE,config.releaseSha);
  // Import application code only once file owners, content and Git metadata
  // match the operator-approved release. All parents are immutable.
  const {selectPinnedMemoryJob}=await import("./activation-contract.mjs");
  const {createVerifiedMemoryLifecycle}=await import("../verified-memory-lifecycle.mjs");
  const {admittedCanonicalJob}=await import("./admitted-canonical-job.mjs");
  const record=selectPinnedMemoryJob(config,operation,jobKey);
  if(!await admittedCanonicalJob(config,record))deny();
  const source=config.sourceCheckouts[record.trustedJob.scope.repositoryId];
  if(!source||typeof source.root!=="string")deny();
  await reviewedRoot(source.root,source.headSha);
  const lifecycle=createVerifiedMemoryLifecycle({
    trustedJob:record.trustedJob,policy:record.policy,
    sourcePath:record.sourcePath,repositoryRoot:source.root,
    authorityRoot:ROOT,observer:()=>{}});
  const answer=operation==="recall"
    ? await lifecycle.recall({scope:record.trustedJob.scope})
    : await lifecycle.promote({issueId:record.trustedJob.scope.issueId,
      jobId:record.trustedJob.jobId});
  const text=JSON.stringify(answer);
  if(Buffer.byteLength(text)>11000)deny();
  process.stdout.write(text+"\n");
}
main().catch(()=>{console.error("memory operator denied");process.exitCode=1;});
