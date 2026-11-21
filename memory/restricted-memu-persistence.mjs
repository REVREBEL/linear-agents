import path from "node:path";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {nativeScopedIdentity} from "./scoped-postgres-recall.mjs";
import {promotionReceiptId} from "./promotion-journal.mjs";
import {readOperatorFile} from "./host-memory-authority.mjs";
import {recallDigest,verifiedRecallEnvelope} from "./scoped-recall.mjs";

const helper=fileURLToPath(new URL("./scripts/restricted-memu-native.py",import.meta.url));
const authorityRoot="/var/lib/bridge-memory-authority";
const runtime="/var/lib/bridge-memory-authority-runtime/bin/python";
const hex=/^[0-9a-f]{64}$/;
const deny=()=>Object.assign(new Error("Restricted memU persistence denied; reconcile any attempted commit"),{code:"ERESTRICTED_MEMU"});
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function restrictedDbIdentity(scope){
  const {userId,agentId}=nativeScopedIdentity(scope);
  const suffix=digest([userId,agentId]).slice(0,56);
  return Object.freeze({userId,agentId,reader:"bmr_"+suffix,writer:"bmw_"+suffix});
}
async function trustedPath(filename,kind){
  // Production never executes a shared agent-writable venv or source tree.
  const resolved=await fs.realpath(filename);
  for(const candidate of new Set([filename,resolved])){
    let f=candidate,first=true;
    while(true){
      const s=await fs.lstat(f);
      if(s.uid!==0||(s.mode&0o022)||(!first&&!s.isDirectory())||
         (first&&!(kind==="file"?(s.isFile()||s.isSymbolicLink()):s.isDirectory())))throw deny();
      const p=path.dirname(f);if(p===f)break;f=p;first=false;
    }
  }
}
function boundedNative({python,home,host,port,database,role,request,spawnImpl=spawn,timeoutMs=60000}){
  const input=JSON.stringify(request);
  if(Buffer.byteLength(input)>131072)throw deny();
  return new Promise((resolve,reject)=>{
    let child;
    try{child=spawnImpl(python,["-I",helper],{shell:false,cwd:home,env:{
      PATH:"/usr/bin:/bin",HOME:home,LANG:"C.UTF-8",PGHOST:host,PGPORT:port,
      PGDATABASE:database,PGUSER:role,MEMU_TELEMETRY:"0",PYTHONNOUSERSITE:"1"},
      stdio:["pipe","pipe","pipe"]});}catch{return reject(deny());}
    let size=0,parts=[],failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL");},timeoutMs);
    child.stdout.on("data",chunk=>{size+=chunk.length;if(size>262144){failed=true;child.kill("SIGKILL");}else parts.push(Buffer.from(chunk));});
    child.stderr.on("data",()=>{});
    child.stdin.on("error",()=>{failed=true;child.kill("SIGKILL");});
    child.once("error",()=>{clearTimeout(timer);reject(deny());});
    child.once("close",code=>{
      clearTimeout(timer);
      if(code!==0||failed)return reject(deny());
      try{resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));}catch{reject(deny());}
    });
    child.stdin.end(input);
  });
}
function validatePayload(payload,identity,id){
  const f=payload?.recall_files?.[0];
  if(!isDeepStrictEqual(payload?.user,identity)||!Array.isArray(payload?.resource)||payload.resource.length||
     !Array.isArray(payload.recall_files)||payload.recall_files.length!==1||f?.name!=="bridge-"+id||f.track!=="memory"||
     typeof f.content!=="string"||!f.content||f.content.length>600||f.content!==f.content.trim()||f.content.startsWith("#")||
     /[\x00-\x1f\x7f]/.test(f.content)||typeof f.description!=="string"||!f.description||
     f.description.length>1024||f.description!==f.description.trim()||/[\x00-\x1f\x7f]/.test(f.description)||
     Object.keys(payload).sort().join(",")!=="recall_files,resource,user"||
     Object.keys(f).sort().join(",")!=="content,description,name,track")throw deny();
}
function bindPersistence({job,root,invoke}){
  const fixed=structuredClone(job),scope=fixed.scope,id=promotionReceiptId(fixed);
  const roles=restrictedDbIdentity(scope),identity=Object.freeze({user_id:roles.userId,agent_id:roles.agentId});
  let attempted=false;
  return Object.freeze({
    roles,
    async commit(payload){
      payload=structuredClone(payload);validatePayload(payload,identity,id);
      if(attempted)throw deny();
      attempted=true; // consume the attempt before any asynchronous work
      const claim=await readOperatorFile(path.join(root,"journal"),id+".commit-started",64);
      if(claim.toString("utf8")!==digest(payload))throw deny();
      try{await readOperatorFile(path.join(root,"journal"),id+".commit-confirmed",64);throw deny();}
      catch(e){if(e.code!=="ENOENT")throw deny();}
      const result=await invoke(roles.writer,{operation:"commit",identity,payload});
      if(!isDeepStrictEqual(result,{recall_files:payload.recall_files,resources:[]}))throw deny();
      return result;
    },
    async recall({approvedSources,trustedDigests,now=Date.now()}={}){
      if(!(approvedSources instanceof Map)||!(trustedDigests instanceof Set)||approvedSources.size>100||
         approvedSources.size===0||trustedDigests.size===0||!Number.isFinite(now))throw deny();
      const sources=new Map(),digests=new Set(trustedDigests);
      for(const [receipt,source] of approvedSources){
        if(!hex.test(receipt)||!isDeepStrictEqual(Object.fromEntries(["tenantId","agentId","repositoryId","issueId"].map(k=>[k,source?.scope?.[k]])),scope)||
           !digests.has(recallDigest(source))||
           verifiedRecallEnvelope({hits:[source]},{scope,trustedDigests:digests,now,limit:1}).entries.length!==1)throw deny();
        sources.set(receipt,structuredClone(source));
      }
      const result=await invoke(roles.reader,{operation:"recall",identity,names:[...sources.keys()].map(r=>"bridge-"+r)});
      if(!Array.isArray(result?.rows)||result.rows.length>sources.size)throw deny();
      const hits=[],seen=new Set();
      for(const row of result.rows){
        if(typeof row?.name!=="string"||!/^bridge-[0-9a-f]{64}$/.test(row.name)||seen.has(row.name))throw deny();
        seen.add(row.name);
        const source=sources.get(row.name.slice(7));
        if(!source)throw deny();
        const description="Verified task learning "+scope.issueId+" "+source.sourceGitSha.slice(0,12)+" "+source.sourcePath+" revision "+source.revision;
        if(source.content===row.content&&row.description===description)hits.push(source);
      }
      return verifiedRecallEnvelope({hits},{scope,trustedDigests:digests,now});
    },
  });
}
/** Production-only trusted host factory. M13 must bind this to the authenticated
 * job and signed approval store. No network DSN/credentials or agent inputs.
 * Root-only peer role mappings and sealed runtime are explicit rollout gates. */
export async function createRestrictedMemuPersistence({job}={}){
  if(process.getuid?.()!==0)throw deny();
  await trustedPath(process.execPath,"file");await trustedPath(runtime,"file");await trustedPath(helper,"file");await trustedPath(authorityRoot,"directory");
  if((await fs.lstat(authorityRoot)).mode&0o077)throw deny();
  return bindPersistence({job,root:authorityRoot,invoke:(role,request)=>boundedNative({
    python:runtime,home:authorityRoot,host:"/var/run/postgresql",port:"5433",database:"agent_memory",role,request})});
}
/** Isolated fixture only: verify the private socket, expected cluster and OS
 * identity. Cannot target the actual database or be used from a root process. */
export async function createDisposableRestrictedMemuPersistence({job,root,socketRoot}={}){
  if(process.getuid?.()===0||!/^\/var\/tmp\/abr59-m12\.[A-Za-z0-9]{8}$/.test(socketRoot||"")||
     await fs.realpath(socketRoot)!==socketRoot)throw deny();
  const stat=await fs.lstat(socketRoot),socket=await fs.lstat(path.join(socketRoot,"socket/.s.PGSQL.55441"));
  if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o077)||!socket.isSocket()||socket.uid!==process.getuid())throw deny();
  return bindPersistence({job,root,invoke:(role,request)=>boundedNative({
    python:"/opt/agents/memu/.venv/bin/python",home:root,host:path.join(socketRoot,"socket"),port:"55441",database:"abr59_m12",role,request})});
}
