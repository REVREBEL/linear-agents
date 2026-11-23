import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {restrictedDbIdentity,createDisposableRestrictedMemuPersistence,trustedPath} from "./restricted-memu-persistence.mjs";
import {nativeScopedIdentity} from "./scoped-postgres-recall.mjs";

const scope={tenantId:"tenant-a",agentId:"agent-a",repositoryId:"Canary/memory",issueId:"CAN-1"};
test("database login identities bind exactly the four scope dimensions and fit PostgreSQL identifier limits",()=>{
  const roles=restrictedDbIdentity(scope),native=nativeScopedIdentity(scope);
  assert.equal(roles.userId,native.userId);
  assert.equal(roles.agentId,native.agentId);
  const suffix=createHash("sha256").update(JSON.stringify([native.userId,native.agentId])).digest("hex").slice(0,56);
  assert.equal(roles.reader,"bmr_"+suffix);
  assert.equal(roles.writer,"bmw_"+suffix);
  assert.ok(Object.isFrozen(roles));
  assert.deepEqual(restrictedDbIdentity({...scope}),roles);
  for(const field of Object.keys(scope)){
    const other=restrictedDbIdentity({...scope,[field]:scope[field]+"-other"});
    assert.notEqual(other.reader,roles.reader);
    assert.notEqual(other.writer,roles.writer);
  }
});
test("missing, unsafe and oversized scopes fail closed before role name construction",()=>{
  for(const invalid of [null,{}, {...scope,agentId:"bad'role"}, {...scope,tenantId:""}, {...scope,issueId:"x".repeat(513)}])
    assert.throws(()=>restrictedDbIdentity(invalid),/invalid trusted scope/);
});
test("disposable factory refuses production, arbitrary database target and invalid socket paths",async()=>{
  for(const socketRoot of ["/var/run/postgresql","/tmp/agent_memory","/var/tmp/abr59-m12.XXXXXXXX/../main",undefined])
    await assert.rejects(createDisposableRestrictedMemuPersistence({job:{scope,prNumber:1,headSha:"a".repeat(40)},root:"/tmp",socketRoot}),/denied/);
});

function pathFixture(){
  const entries=new Map();
  const add=(name,type,mode=0o755,uid=0,target)=>entries.set(name,{
    uid,mode,target,isDirectory:()=>type==="dir",isFile:()=>type==="file",isSymbolicLink:()=>type==="link"
  });
  for(const d of ["/","/var","/var/lib","/var/lib/runtime","/var/lib/runtime/bin","/usr","/usr/bin","/tmp"])add(d,"dir");
  add("/var/lib/runtime/bin/python","link",0o777,0,"python3");
  add("/var/lib/runtime/bin/python3","link",0o777,0,"/usr/bin/python3");
  add("/usr/bin/python3","link",0o777,0,"python3.13");
  add("/usr/bin/python3.13","file");
  return {add,io:{lstat:async f=>{if(!entries.has(f))throw Error("missing");return entries.get(f);},
    readlink:async f=>entries.get(f).target}};
}
test("root-owned venv symlink chain preserves original executable path despite mode 0777",async()=>{
  const {io}=pathFixture();
  await trustedPath("/var/lib/runtime/bin/python","file",io);
  await trustedPath("/var/lib/runtime","directory",io);
});
test("rejects insecure symlink hops, real files, ancestors, traversal, directory aliases and cycles",async()=>{
  for(const configure of [
    f=>f.add("/var/lib/runtime/bin/python3","link",0o777,1000,"/usr/bin/python3"),
    f=>f.add("/usr/bin/python3.13","file",0o775),
    f=>f.add("/usr/bin/python3.13","file",0o755,1000),
    f=>f.add("/usr/bin","dir",0o777),
    f=>f.add("/var/lib/runtime","dir",0o755,1000),
    f=>f.add("/var/lib/runtime/bin","link",0o777,0,"/usr/bin"),
    f=>f.add("/var/lib/runtime/bin/python3","link",0o777,0,"../bin/python"),
    f=>f.add("/var/lib/runtime/bin/python3","link",0o777,0,"python"),
    f=>f.add("/usr/bin/python3.13","dir"),
  ]){
    const f=pathFixture();configure(f);
    await assert.rejects(trustedPath("/var/lib/runtime/bin/python","file",f.io),/denied/);
  }
});
