import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {restrictedDbIdentity,createDisposableRestrictedMemuPersistence} from "./restricted-memu-persistence.mjs";
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
