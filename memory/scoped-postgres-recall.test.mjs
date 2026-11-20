import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { nativeScopedIdentity, makeScopedRecallSql, readScopedMemuFiles }
  from "./scoped-postgres-recall.mjs";
import { recallDigest } from "./scoped-recall.mjs";
import { buildVerifiedMemuPayload } from "./memu-commit-executor.mjs";
import { promotionReceiptId } from "./promotion-journal.mjs";

const scope = { tenantId:"tenant-1",agentId:"qwen-local",
  repositoryId:"REVREBEL/linear-agents",issueId:"ABR-59" };
const receipt = "b".repeat(64);
const approved = { scope, sourceGitSha:"a".repeat(40),
  sourcePath:"docs/agent-bridge.md",revision:1,
  expiresAt:"2027-01-01T00:00:00Z",content:"Reviewed safe recall note for scoped testing." };
const allowed = new Set([recallDigest(approved)]);
function fakePsql(rows, observe = () => {}) {
  return (binary,argv,opts)=>{
    observe(binary,argv,opts);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill=()=>true;
    let query="";
    child.stdin.on("data",c=>query+=String(c));
    child.stdin.on("finish",()=>{
      assert.equal(query,makeScopedRecallSql());
      setImmediate(()=>{
        child.stdout.end(JSON.stringify(rows));
        child.emit("close",0);
      });
    });
    return child;
  };
}
const read = (rows,options={})=>readScopedMemuFiles({
  scope,approvedSources:new Map([[receipt,approved]]),trustedDigests:allowed,
  now:Date.parse("2026-11-20T00:00:00Z"),spawnImpl:fakePsql(rows),...options,
});
test("scope hashing matches M4 native memU user_id derivation",async()=>{
  const identity=nativeScopedIdentity(scope);
  const expected=createHash("sha256").update(JSON.stringify([
    scope.tenantId,scope.repositoryId,scope.issueId,
  ])).digest("hex");
  assert.equal(identity.userId,expected);
  assert.equal(identity.agentId,"qwen-local");
  assert.equal(identity.userId.length,64);
});
test("parameterized SQL filters both parent and child scope BEFORE returning any content",()=>{
  const query=makeScopedRecallSql();
  assert.match(query,/BEGIN READ ONLY/);
  assert.match(query,/f\.user_id = :'scoped_user_id'/);
  assert.match(query,/f\.agent_id = :'scoped_agent_id'/);
  assert.match(query,/s\.user_id = :'scoped_user_id'/);
  assert.match(query,/s\.agent_id = :'scoped_agent_id'/);
  assert.match(query,/f\.track = 'memory'/);
  assert.doesNotMatch(query,/\b(?:INSERT|UPDATE|DELETE|DROP|CREATE)\s+/i);
});
test("only exact approved and source-digested matching DB content is returned",async()=>{
  const result=await read([
    {name:"bridge-"+receipt,content:approved.content},
    {name:"bridge-"+"c".repeat(64),content:"untrusted"},
  ]);
  assert.equal(result.trust,"untrusted-reference-only");
  assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].content,approved.content);
  assert.equal(result.entries[0].sourceGitSha,approved.sourceGitSha);
});
test("DB text mutation, forged provenance and foreign approved scope all fail closed",async()=>{
  const corrupt=await read([{name:"bridge-"+receipt,content:approved.content+" contaminated"}]);
  assert.equal(corrupt.entries.length,0);
  const foreign=await read([{name:"bridge-"+receipt,content:approved.content}],
    {approvedSources:new Map([[receipt,{...approved,scope:{...scope,tenantId:"foreign"}}]])});
  assert.equal(foreign.entries.length,0);
  const stale=await read([{name:"bridge-"+receipt,content:approved.content}],
    {trustedDigests:new Set(["c".repeat(64)])});
  assert.equal(stale.entries.length,0);
});
test("scope query args use direct process, private DB socket and bounded output",async()=>{
  let invoked=0;
  const result=await read([{name:"bridge-"+receipt,content:approved.content}],
    {spawnImpl:fakePsql([{name:"bridge-"+receipt,content:approved.content}],
      (binary,argv,opts)=>{
        invoked++;
        assert.equal(binary,"/usr/bin/psql");
        assert.equal(opts.shell,false);
        assert.equal(opts.env.PGHOST,"/var/run/postgresql");
        assert.equal(opts.env.PGDATABASE,"agent_memory");
        assert.ok(argv.includes("scoped_user_id="+nativeScopedIdentity(scope).userId));
        assert.ok(argv.includes("scoped_agent_id=qwen-local"));
        assert.ok(!argv.join(" ").includes("tenant-1"));
      })});
  assert.equal(invoked,1);
  assert.equal(result.entries.length,1);
});
test("invalid identity and missing approved control plane prevent subprocess launch",async()=>{
  let invoked=0;
  const spawnImpl=()=>{invoked++;throw Error("must not launch");};
  for (const invalid of [
    {scope:{...scope,agentId:"qwen'; DROP TABLE memu.recall_files; --"}},
    {trustedDigests:new Set()},
    {approvedSources:new Map()},
  ]) await assert.rejects(readScopedMemuFiles({
    scope,approvedSources:new Map([[receipt,approved]]),trustedDigests:allowed,
    spawnImpl,...invalid,
  }),/Scoped recall unavailable/);
  assert.equal(invoked,0);
});
test("invalid native DB response and CLI errors never become recalled text",async()=>{
  await assert.rejects(read(["invalid"],{
    spawnImpl:fakePsql(["invalid"]),
  }),/invalid authorized response/);
});

test("M4 prepared write and M5 authorized read use identical native identity",()=>{
  const receipt = {
    state: "verified-awaiting-executor",
    scope, prNumber: 256, headSha: "a".repeat(40),
    proof: { status: "verified-after-merge",
      repository: scope.repositoryId, prNumber: 256,
      headSha: "a".repeat(40) },
  };
  receipt.id=promotionReceiptId(receipt);
  const result=buildVerifiedMemuPayload({
    receipt,candidate: { sourceGitSha:receipt.headSha,
      sourcePath:"docs/agent-bridge.md",revision:1,
      content:"Reviewed scoped memory source and isolated test." },
  });
  assert.equal(result.user.user_id,nativeScopedIdentity(scope).userId);
  assert.equal(result.user.agent_id,nativeScopedIdentity(scope).agentId);
});
