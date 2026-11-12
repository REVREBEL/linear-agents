import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getWorkerRegistry, requireWorker } from "./agent-worker-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("all seven existing Worker paths resolve through the registry without relocation", () => {
  const registry = getWorkerRegistry();
  assert.equal(registry.size, 7);
  for (const entry of registry.values()) {
    assert.ok(entry.workerDir.startsWith(root + path.sep));
    assert.ok(readFileSync(path.join(entry.workerDir,entry.worker.config),"utf8").includes("LINEAR_DATA"));
  }
  assert.equal(requireWorker("chatgpt-cli").linear.credentialPrefix,"CHATGPT");
  assert.equal(requireWorker("mock").worker.directory,"agents/coding/mock/worker");
  assert.equal(requireWorker("chatgpt-cli").worker.directory,"agents/coding/chatgpt-cli/worker");
  assert.equal(requireWorker("chatgpt-cli").worker.deployedName,"linear-chatgpt-cli-agent");
  assert.equal(requireWorker("chatgpt-cli").linear.credentialPrefix,requireWorker("chatgpt").linear.credentialPrefix);
  assert.equal(requireWorker("gemini").worker.directory,"agents/coding/gemini/worker");
  assert.equal(requireWorker("trae").worker.directory,"agents/coding/trae/worker");
  assert.notEqual(requireWorker("chatgpt").worker.kvEnv,requireWorker("chatgpt-cli").worker.kvEnv);
});

test("registry shell bridge uses safe fields and rejects unknown agents", () => {
  const cli=path.join(root,"scripts/registry-worker-info.mjs");
  const valid=execFileSync(process.execPath,[cli,"chatgpt-cli"],{encoding:"utf8"}).trim().split("\t");
  assert.deepEqual(valid,[path.join(root,"agents/coding/chatgpt-cli/worker"),"CHATGPT_CLI","CHATGPT"]);
  const invalid=spawnSync(process.execPath,[cli,"../invalid"],{encoding:"utf8"});
  assert.notEqual(invalid.status,0);
});

test("render-wrangler preserves separate Worker identities and routes without deploying", () => {
  const temp=mkdtempSync(path.join(os.tmpdir(),"registry-wrangler-"));
  try {
    for (const id of ["antigravity","chatgpt","chatgpt-cli","gemma"]) {
      const key=id.toUpperCase().replaceAll("-","_");
      const output=path.join(temp,id+".jsonc");
      const result=spawnSync(process.execPath,[path.join(root,"scripts/render-wrangler.mjs"),id,output],{
        encoding:"utf8",
        env:{...process.env,REPO_ROOT:root,DOMAIN:"example.com",[key+"_KV_NAMESPACE_ID"]:"a".repeat(32)}
      });
      assert.equal(result.status,0,result.stderr);
      const text=readFileSync(output,"utf8");
      assert.ok(text.includes('"name": "linear-'+id+'-agent"'));
      assert.ok(text.includes("linear-"+id+".example.com"));
      assert.ok(text.includes('"binding": "LINEAR_DATA"'));
      assert.ok(!text.includes("\${"),"unresolved environment token");
      if(["antigravity","chatgpt"].includes(id))
        assert.ok(text.includes("github-"+id+".example.com"));
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
