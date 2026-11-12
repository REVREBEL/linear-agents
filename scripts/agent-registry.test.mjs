import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.throws(() => validateRegistry(traversal,schema), /unsafe path/);
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
