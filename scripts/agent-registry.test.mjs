import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateRegistry } from "./validate-agent-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(path.join(root, "agents/registry.json"), "utf8"));
const schema = JSON.parse(readFileSync(path.join(root, "agents/registry.schema.json"), "utf8"));
const copy = () => structuredClone(registry);

test("agent registry validates against checked-in Worker names and bindings", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(registry.schemaVersion, 2);
  assert.equal(validateRegistry(registry, schema), true);
});

test("agent registry refuses duplicate IDs, directories and KV bindings", () => {
  const duplicateId = copy(); duplicateId.agents[1].id = duplicateId.agents[0].id;
  assert.throws(() => validateRegistry(duplicateId,schema), /duplicate agent id/);
  const duplicatePath = copy(); duplicatePath.agents[1].worker.directory = duplicatePath.agents[0].worker.directory;
  assert.throws(() => validateRegistry(duplicatePath,schema), /duplicate Worker directory/);
  const duplicateKv = copy(); duplicateKv.agents[1].worker.kvEnv = duplicateKv.agents[0].worker.kvEnv;
  assert.throws(() => validateRegistry(duplicateKv,schema), /unexpected Worker bindings|duplicate KV/);
});

test("agent registry refuses unsafe paths and Worker identity drift", () => {
  const traversal = copy(); traversal.agents[0].worker.directory = "../private";
  assert.throws(() => validateRegistry(traversal,schema), /unsafe path|invalid pattern/);
  const drift = copy(); drift.agents[0].worker.serviceTemplate = "linear-wrong-agent";
  assert.throws(() => validateRegistry(drift,schema), /service name drift/);
});

test("ChatGPT review and CLI must remain separate Workers/KV despite shared OAuth app", () => {
  const bad = copy(); bad.agents.find(x=>x.id==="chatgpt-cli").linear.appIdentity="chatgpt-cli";
  assert.throws(() => validateRegistry(bad,schema), /share app credentials/);
});

test("v2 rejects undocumented capability fields and invalid rating scores", () => {
  const unknown = copy();
  unknown.agents[0].profile.routing.unknownCapability = "surprise";
  assert.throws(() => validateRegistry(unknown,schema), /unknown property/);
  const badRating = copy();
  badRating.agents[0].profile.routing.task_ratings.refactoring.score = 7;
  assert.throws(() => validateRegistry(badRating,schema), /exceeds maximum/);
  const missingRatingSource = copy();
  delete missingRatingSource.agents[0].profile.routing.task_ratings.refactoring.source;
  assert.throws(() => validateRegistry(missingRatingSource,schema), /missing source/);
});

test("v2 enforces identity separation and fail-closed execution policies", () => {
  const duplicateDeployment = copy();
  duplicateDeployment.agents[2].worker.deployedName = duplicateDeployment.agents[1].worker.deployedName;
  assert.throws(() => validateRegistry(duplicateDeployment,schema), /duplicate deployed Worker identity/);
  const permissions = copy();
  permissions.agents[0].executionPolicy.permissions.deployment = true;
  assert.throws(() => validateRegistry(permissions,schema), /cannot authorize deployment/);
  const invalidTool = copy();
  invalidTool.agents[0].executionPolicy.security.envStripPatterns.push("INVALID;rm -rf /");
  assert.throws(() => validateRegistry(invalidTool,schema), /invalid pattern/);
});

test("v2 keeps code-review and coding identities separate, with no secret values", () => {
  const review = registry.agents.find(x=>x.id==="chatgpt");
  const cli = registry.agents.find(x=>x.id==="chatgpt-cli");
  assert.notEqual(review.worker.deployedName,cli.worker.deployedName);
  assert.equal(review.linear.appIdentity,cli.linear.appIdentity);
  const agy = registry.agents.find(x=>x.id==="antigravity");
  assert.equal(agy.runtimeContract.executable.binaryEnv,"AGY_BIN");
  assert.deepEqual(agy.runtimeContract.executable.argv.slice(0,2),["-p","{{PROMPT}}"]);
  assert.equal(agy.executionPolicy.permissions.deployment,false);
  assert.equal(agy.profile.routing.task_ratings.refactoring.source,"user_supplied");
});

test("current package path is validated while target path may not exist until P3", () => {
  const absent = copy();
  absent.agents[0].packageDir = "agents/coding/not-yet-moved";
  assert.throws(() => validateRegistry(absent,schema), /packageDir missing/);
  const target = copy();
  target.agents[0].targetPackageDir = "agents/coding/next-location";
  assert.equal(validateRegistry(target,schema),true);
});

test("Wrangler template KV and Durable Object bindings must match their registry entry", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(),"agent-registry-"));
  try {
    for (const agent of registry.agents) {
      for (const relative of [agent.packageDir,agent.worker.directory]) {
        mkdirSync(path.join(temp,relative),{recursive:true});
      }
      const configPath=path.join(agent.worker.directory,agent.worker.config);
      copyFileSync(path.join(root,configPath),path.join(temp,configPath));
    }
    const cli = registry.agents.find(a=>a.id==="chatgpt-cli");
    const configPath=path.join(temp,cli.worker.directory,cli.worker.config);
    const original=readFileSync(configPath,"utf8");
    writeFileSync(configPath,original.replace('"binding": "LINEAR_DATA"','"binding": "OTHER_BINDING"'));
    assert.throws(() => validateRegistry(registry,schema,{root:temp}),/KV namespace binding drift/);
    writeFileSync(configPath,original.replace('"name": "DELIVERY_COORDINATOR"','"name": "OTHER_OBJECT"'));
    assert.throws(() => validateRegistry(registry,schema,{root:temp}),/Durable Object binding drift/);
    writeFileSync(configPath,original);
    assert.equal(validateRegistry(registry,schema,{root:temp}),true);
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
});

test("schema service-name pattern rejects invalid value even when matching template", () => {
  const invalid = copy();
  invalid.agents[2].worker.serviceTemplate = "linear-chatgpt-worker";
  assert.throws(() => validateRegistry(invalid,schema),/invalid pattern/);
});
