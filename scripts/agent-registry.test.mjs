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
