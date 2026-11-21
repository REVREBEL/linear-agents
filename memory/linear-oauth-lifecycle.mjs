import fs from "node:fs/promises";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {readOperatorFile} from "./host-memory-authority.mjs";
import {LINEAR_COMPLETION_TIMEOUT_MS} from "./linear-completion-client.mjs";

const TOKEN_URL="https://api.linear.app/oauth/token";
const GRAPHQL_URL="https://api.linear.app/graphql";
const CACHE="linear-oauth.token";
const MAX_LIFETIME=30*86400;
const locks=new Map();
const valid=value=>typeof value==="string" && value.length>=12 && value.length<=4096 && !/[\x00-\x20\x7f]/.test(value);
function deny(){return Object.assign(new Error("Host Linear OAuth credentials unavailable or rejected"),{code:"EHOST_LINEAR_OAUTH_DENIED"});}
async function serialized(root,fn){
  const previous=locks.get(root)||Promise.resolve();
  const run=previous.catch(()=>{}).then(fn);
  locks.set(root,run);
  try{return await run;}finally{if(locks.get(root)===run)locks.delete(root);}
}
async function readJSON(response,limit=16384){
  if(!response.body?.getReader)throw deny();
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw deny();}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,size)));
}
async function credentials(root){
  const rawId=await readOperatorFile(root,"linear-client.id",4096);
  const rawSecret=await readOperatorFile(root,"linear-client.secret",4096);
  try{
    const clientId=rawId.toString("utf8").trim(),clientSecret=rawSecret.toString("utf8").trim();
    if(!valid(clientId)||!valid(clientSecret))throw deny();
    return {clientId,clientSecret,fingerprint:createHash("sha256").update(JSON.stringify([clientId,clientSecret])).digest("hex")};
  }finally{rawId.fill(0);rawSecret.fill(0);}
}
async function readCache(root){
  let bytes;
  try{bytes=await readOperatorFile(root,CACHE,16384);}
  catch(e){if(e.code==="ENOENT")return null;throw e;}
  try{
    // Older manually provisioned raw tokens are never trusted as cache entries.
    return JSON.parse(bytes.toString("utf8"));
  }catch{return null;}finally{bytes.fill(0);}
}
async function publish(root,record){
  const temporary=path.join(root,".linear-oauth-"+randomUUID());
  try{
    const handle=await fs.open(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,path.join(root,CACHE));
    const dir=await fs.open(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{await dir.sync();}finally{await dir.close();}
  }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=="ENOENT")throw e;});}
}
async function requestAccessToken(c,fetchImpl,now){
    const started=now();
    const response=await fetchImpl(TOKEN_URL,{method:"POST",redirect:"error",
      headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
      body:new URLSearchParams({grant_type:"client_credentials",scope:"read",client_id:c.clientId,client_secret:c.clientSecret}).toString(),
      signal:AbortSignal.timeout(10000)});
    if(response.status!==200)throw deny();
    const data=await readJSON(response);
    const scopes=Array.isArray(data.scope)?data.scope:typeof data.scope==="string"?data.scope.split(/[ ,]+/):[];
    if(!valid(data.access_token)||typeof data.token_type!=="string"||data.token_type.toLowerCase()!=="bearer"||
       scopes.length!==1||scopes[0]!=="read"||!Number.isSafeInteger(data.expires_in)||
       data.expires_in<60||data.expires_in>MAX_LIFETIME)throw deny();
  return {token:data.access_token,issuedAt:started,expiresAt:started+data.expires_in*1000};
}

// Explicit operator bootstrap. Return only candidate identity metadata; the
// operator must review and pin the actor before the regular cache is created.
export async function discoverLinearOAuthIdentity({root,expectedWorkspaceId,fetchImpl=fetch}={}){
  try{
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!uuid.test(expectedWorkspaceId||""))throw deny();
    const c=await credentials(root);
    const grant=await requestAccessToken(c,fetchImpl,Date.now);
    const r=await fetchImpl(GRAPHQL_URL,{method:"POST",redirect:"error",
      headers:{Authorization:"Bearer "+grant.token,"Content-Type":"application/json"},
      body:JSON.stringify({query:"query BridgeAuthorityBootstrap { viewer { id name } organization { id name } }"}),
      signal:AbortSignal.timeout(10000)});
    if(r.status!==200)throw deny();
    const v=await readJSON(r);
    if(v.errors?.length||v.data?.organization?.id!==expectedWorkspaceId||
       !uuid.test(v.data?.viewer?.id||""))throw deny();
    if((await credentials(root)).fingerprint!==c.fingerprint)throw deny();
    return Object.freeze({workspaceId:v.data.organization.id,workspaceName:v.data.organization.name,
      actorId:v.data.viewer.id,actorName:v.data.viewer.name,scope:"read"});
  }catch{throw deny();}
}

export function createLinearOAuthLifecycle({root,workspaceId,actorId,fetchImpl=fetch,now=Date.now}={}){
  if(!root||typeof workspaceId!=="string"||typeof actorId!=="string")throw deny();
  async function verify(token){
    const response=await fetchImpl(GRAPHQL_URL,{method:"POST",redirect:"error",
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({query:"query BridgeAuthorityIdentity { viewer { id } organization { id } }"}),
      signal:AbortSignal.timeout(10000)});
    if(response.status===401){await response.body?.cancel();return false;}
    if(response.status!==200)throw deny();
    const v=await readJSON(response);
    if(v.errors?.length||v.data?.viewer?.id!==actorId||v.data?.organization?.id!==workspaceId)throw deny();
    return true;
  }
  async function issue(c){
    const granted=await requestAccessToken(c,fetchImpl,now);
    const record={version:1,...granted,scope:"read",workspaceId,actorId,fingerprint:c.fingerprint};
    if(record.expiresAt<=now()||!await verify(record.token))throw deny();
    if((await credentials(root)).fingerprint!==c.fingerprint)throw deny();
    await publish(root,record);
    return record.token;
  }
  function reusable(record,c,rejected){
    const ttl=record?.expiresAt-record?.issuedAt;
    return record?.version===1&&record.scope==="read"&&record.workspaceId===workspaceId&&record.actorId===actorId&&
      record.fingerprint===c.fingerprint&&valid(record.token)&&record.token!==rejected&&
      Number.isSafeInteger(record.issuedAt)&&Number.isSafeInteger(record.expiresAt)&&
      record.issuedAt<=now()&&ttl>=60000&&ttl<=MAX_LIFETIME*1000&&
      record.expiresAt-now()>Math.min(86400000,Math.max(30000,ttl/10));
  }
  async function getToken(rejected){
    try{return await serialized(root,async()=>{
      const c=await credentials(root),cached=await readCache(root);
      if(reusable(cached,c,rejected)&&await verify(cached.token)){
        if((await credentials(root)).fingerprint!==c.fingerprint)throw deny();
        return cached.token;
      }
      return issue(c);
    });}catch{throw deny();}
  }
  async function fetchGraphQL(url,options){
    // This wrapper is only for the read-only completion adapter.
    if(url!==GRAPHQL_URL||options?.method!=="POST"||options.redirect!=="error")throw deny();
    const expected="Bearer ";
    const header=options.headers?.Authorization;
    if(typeof header!=="string"||!header.startsWith(expected)||!valid(header.slice(expected.length)))throw deny();
    const response=await fetchImpl(url,options);
    if(response.status!==401)return response;
    await response.body?.cancel();
    const fresh=await getToken(header.slice(expected.length));
    // Give the single retry its own bounded query budget after renewal.
    return fetchImpl(url,{...options,headers:{...options.headers,Authorization:expected+fresh},
      signal:AbortSignal.timeout(LINEAR_COMPLETION_TIMEOUT_MS)});
  }
  return Object.freeze({getToken,fetchGraphQL});
}
