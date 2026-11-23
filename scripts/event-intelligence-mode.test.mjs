import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const secret="dedicated-reviewer-only-intake-token-value-001";
const baseEnv={
  PATH:process.env.PATH||"/usr/bin:/bin", HOME:process.env.HOME||"/tmp",
  DOMAIN:"revrebel.io", CHATGPT_PREFIX:"chatgpt",
  CHATGPT_KV_NAMESPACE_ID:"a".repeat(32),
};
const run=(file,vars={})=>spawnSync(process.execPath,
  [path.join(root,"scripts/render-wrangler.mjs"),"chatgpt",file],
  {cwd:root,encoding:"utf8",env:{...baseEnv,...vars}});

test("ChatGPT Worker defaults EventIntelligence to off with no intake credential",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"abr18-wrangler-"));
  try {
    const output=path.join(dir,"wrangler-off.jsonc");
    const result=run(output);
    assert.equal(result.status,0,result.stderr);
    const text=await fs.readFile(output,"utf8");
    assert.match(text,/"EVENT_INTELLIGENCE_MODE"\s*:\s*"off"/);
    assert.equal(text.includes("EVENT_INTELLIGENCE_INTAKE_TOKEN"),false);
    assert.equal((await fs.stat(output)).mode&0o777,0o600);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("shadow mode requires a separate 32+ character token, never rendered as a Wrangler var",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"abr18-wrangler-"));
  try {
    const approved=path.join(dir,"shadow.jsonc");
    const success=run(approved,{CHATGPT_EVENT_INTELLIGENCE_MODE:"shadow",
      CHATGPT_EVENT_INTELLIGENCE_INTAKE_TOKEN:secret});
    assert.equal(success.status,0,success.stderr);
    const content=await fs.readFile(approved,"utf8");
    assert.match(content,/"EVENT_INTELLIGENCE_MODE"\s*:\s*"shadow"/);
    assert.equal(content.includes(secret),false);
    assert.equal(content.includes("EVENT_INTELLIGENCE_INTAKE_TOKEN"),false);
    for(const [name,vars] of Object.entries({
      missing:{CHATGPT_EVENT_INTELLIGENCE_MODE:"shadow"},
      short:{CHATGPT_EVENT_INTELLIGENCE_MODE:"shadow",
        CHATGPT_EVENT_INTELLIGENCE_INTAKE_TOKEN:"too-short"},
      enforcement:{CHATGPT_EVENT_INTELLIGENCE_MODE:"enforced",
        CHATGPT_EVENT_INTELLIGENCE_INTAKE_TOKEN:secret},
    })){
      const file=path.join(dir,name+".jsonc"),failure=run(file,vars);
      assert.notEqual(failure.status,0,name);
      assert.match(failure.stderr,/EVENT_INTELLIGENCE/);
      await assert.rejects(fs.stat(file),{code:"ENOENT"});
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
