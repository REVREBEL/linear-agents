import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolveBridgeProjectDirectory} from "./runtime-project-root.mjs";

const code="/var/lib/bridge-runtime/linear-agent-bridge";
const data="/home/bridge/agent-bridge/linear-agent-bridge";
test("sealed source path stays separate from operator-owned runtime data",()=>{
  assert.equal(resolveBridgeProjectDirectory(code),code);
  assert.equal(resolveBridgeProjectDirectory(code,data),data);
  assert.equal(resolveBridgeProjectDirectory(code,""),code);
});
test("relative, traversing and control-character runtime paths are rejected",()=>{
  for(const bad of ["relative","../escape","/home/bridge/../root",
    "/home/bridge/./private","/home/bridge/data/","/",
    "/home/bridge/\nprivate",null,12]){
    assert.throws(()=>resolveBridgeProjectDirectory(code,bad),/Invalid runtime project directory/);
  }
  assert.throws(()=>resolveBridgeProjectDirectory("relative",data),/Invalid source project directory/);
});

test("managed submission verifies the sealed executable source, not mutable runtime data",()=>{
  const source=readFileSync(fileURLToPath(new URL("./agent-bridge-runtime.mjs",import.meta.url)),"utf8");
  assert.match(source,/verifyManagedSubmissionActivation\(hostBinding,path\.resolve\(SOURCE_PROJECT_DIR,"\.\."\)\)/);
  assert.doesNotMatch(source,/verifyManagedSubmissionActivation\(hostBinding,path\.resolve\(PROJECT_DIR,"\.\."\)\)/);
});

test("sealed executable and handoff paths never resolve through writable runtime",()=>{
  const source=readFileSync(fileURLToPath(new URL("./agent-bridge-runtime.mjs",import.meta.url)),"utf8");
  assert.match(source,/path\.resolve\(SOURCE_PROJECT_DIR, "\.\.\/scripts\/chatgpt-shortcuts\/handoff\.mjs"\)/);
  assert.match(source,/path\.join\(SOURCE_PROJECT_DIR, "run_agent\.py"\)/);
  assert.doesNotMatch(source,/path\.resolve\(PROJECT_DIR, "\.\.\/scripts\/chatgpt-shortcuts\/handoff\.mjs"\)/);
  // The shortcut does not need the Bridge's authentication environment.
  assert.doesNotMatch(source,/cwd: path\.resolve\(PROJECT_DIR, "\.\."\), env: process\.env/);
});

test("sealed unit retains canonical identity and strips Bash startup hooks",()=>{
  const unit=readFileSync(fileURLToPath(new URL("../../scripts/linux/systemd/agent-bridge.service",import.meta.url)),"utf8");
  const launcher=readFileSync(fileURLToPath(new URL("../../scripts/linux/launch-sealed-bridge.sh",import.meta.url)),"utf8");
  assert.match(unit,/^ExecStart=\/usr\/bin\/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS/m);
  assert.match(unit,/\/usr\/bin\/bash \/var\/lib\/bridge-runtime\/scripts\/linux\/launch-sealed-bridge\.sh/);
  assert.match(launcher,/EXPECTED_DATA_REAL=\/opt\/workspaces\/linear-agents\/linear-agent-bridge/);
  assert.match(launcher,/\/usr\/bin\/realpath -e -- "\$DATA_DIR"/);
  assert.match(launcher,/\/usr\/bin\/find "\$DATA_DIR\/linear-jobs\/job-state"/);
  assert.match(launcher,/-name state\.json -type f -print -quit/);
  assert.match(launcher,/SEALED_BRIDGE_PREFLIGHT=PASS/);
  assert.match(launcher,/exec \/usr\/bin\/node "\$CODE_FILE"/);
});
test("M14 CI covers canonical Bridge source in both PR and main push",()=>{
  const workflow=readFileSync(fileURLToPath(new URL("../../.github/workflows/memory-authority-m14.yml",import.meta.url)),"utf8");
  assert.equal((workflow.match(/- "bridge\/server\/agent-bridge-runtime\.mjs"/g)||[]).length,2);
  assert.equal((workflow.match(/- "scripts\/linux\/systemd\/agent-bridge\.service"/g)||[]).length,2);
  assert.doesNotMatch(workflow,/agent-bridge-sealed\.service/);
});
