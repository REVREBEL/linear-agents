#!/usr/bin/env node
// Dependency-free validation of the versioned agent registry and its checked-in
// Wrangler templates. Never reads .env, KV IDs, OAuth tokens, or live state.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const regPath = path.join(root, "agents/registry.json");
const schemaPath = path.join(root, "agents/registry.schema.json");
const agents = ["antigravity","chatgpt","chatgpt-cli","gemini","gemma","trae","mock"];
const fail = (message) => { throw new Error("Agent registry: " + message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys, label) => {
  if (!object(value)) fail(label + " must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(label + " has unknown property " + key);
  for (const key of keys) if (!Object.hasOwn(value,key)) fail(label + " is missing " + key);
};

// Generic Draft 2020-12 subset used by this self-contained schema.
// Validates all nested v2 discovery and policy metadata without npm dependencies.
// Unknown validation keywords fail closed rather than being silently ignored.
export function validateAgainstSchema(value, node, schema, location = "$") {
  if (node.$ref) {
    if (!node.$ref.startsWith("#/$defs/")) fail(location + " unsupported schema reference");
    const definition = schema.$defs[node.$ref.slice("#/$defs/".length)];
    if (!definition) fail(location + " unresolved schema reference");
    return validateAgainstSchema(value, definition, schema, location);
  }
  const supported = new Set(["$schema","$id","$defs","type","properties","required","additionalProperties","items","enum","const","pattern","minLength","minItems","minimum","maximum","description","title"]);
  for (const key of Object.keys(node)) if (!supported.has(key)) fail(location + " unsupported schema keyword " + key);
  if (node.type) {
    const valid = node.type === "object" ? object(value) :
      node.type === "array" ? Array.isArray(value) :
      node.type === "integer" ? Number.isSafeInteger(value) :
      node.type === "number" ? typeof value === "number" && Number.isFinite(value) :
      node.type === "boolean" ? typeof value === "boolean" :
      node.type === "string" ? typeof value === "string" : false;
    if (!valid) fail(location + " expected " + node.type);
  }
  if (Object.hasOwn(node,"const") && value !== node.const) fail(location + " const mismatch");
  if (node.enum && !node.enum.includes(value)) fail(location + " invalid enum value");
  if (node.pattern && !new RegExp(node.pattern).test(value)) fail(location + " invalid pattern");
  if (node.minLength !== undefined && value.length < node.minLength) fail(location + " too short");
  if (node.minimum !== undefined && value < node.minimum) fail(location + " below minimum");
  if (node.maximum !== undefined && value > node.maximum) fail(location + " exceeds maximum");
  if (node.minItems !== undefined && value.length < node.minItems) fail(location + " too few items");
  if (object(value)) {
    for (const key of node.required || []) if (!Object.hasOwn(value,key)) fail(location + " missing " + key);
    for (const [key,subValue] of Object.entries(value)) {
      const rule = node.properties?.[key];
      if (rule) validateAgainstSchema(subValue,rule,schema,location+"."+key);
      else if (node.additionalProperties === false) fail(location + " unknown property " + key);
      else if (object(node.additionalProperties)) validateAgainstSchema(subValue,node.additionalProperties,schema,location+"."+key);
    }
  }
  if (Array.isArray(value) && node.items)
    for(let i=0;i<value.length;i++) validateAgainstSchema(value[i],node.items,schema,location+"["+i+"]");
}

export function parseWranglerJsonc(source) {
  // Preserve quoted JSON strings while removing line/block comments.
  let text = "", inString = false, escaping = false;
  for (let i = 0; i < source.length; i++) {
    const current = source[i], next = source[i + 1];
    if (inString) {
      text += current;
      if (escaping) escaping = false;
      else if (current === "\\") escaping = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true; text += current;
    } else if (current === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      text += "\n";
    } else if (current === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i >= source.length) fail("unterminated Wrangler JSONC comment");
      i++;
      text += " ";
    } else text += current;
  }
  // Remove trailing commas outside JSON strings.
  let json = "", quoted = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      json += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true; json += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") json += ch;
    } else json += ch;
  }
  try { return JSON.parse(json); }
  catch (error) { fail("invalid Wrangler JSONC: " + error.message); }
}

export function validateRegistry(registry, schema, options = {}) {
  const base = options.root || root;
  exact(registry, ["schemaVersion","agents"], "root");
  if (registry.schemaVersion !== 2 || schema?.properties?.schemaVersion?.const !== 2)
    fail("unsupported schema version");
  validateAgainstSchema(registry, schema, schema);
  if (!Array.isArray(registry.agents) || registry.agents.length < agents.length)
    fail("expected all seven baseline agents");
  const ids = new Set(), directories = new Set(), kvBindings = new Set(), prefixVars = new Set(), deployed = new Set();
  for (const entry of registry.agents) {
    exact(entry, ["id","role","provider","packageDir","targetPackageDir","worker","execution","linear","profile","runtimeContract","executionPolicy"], "agent");
    if (ids.has(entry.id)) fail("invalid or duplicate agent id: " + entry.id);
    ids.add(entry.id);
    const name = entry.id;
    if (!["coding","review","testing"].includes(entry.role))
      fail(name + " has unsupported role/provider");
    if (!["bridge","macos","configurable"].includes(entry.execution?.host) ||
      Object.keys(entry.execution).sort().join() !== "host,runtime")
      fail(name + " has invalid execution settings");
    exact(entry.linear, ["appIdentity","credentialPrefix"], name + ".linear");
    if (!/^[a-z][a-z0-9-]+$/.test(entry.linear.appIdentity) ||
      !/^[A-Z][A-Z0-9_]+$/.test(entry.linear.credentialPrefix))
      fail(name + " has invalid Linear app identity/prefix");
    exact(entry.worker, ["directory","config","serviceTemplate","deployedName","prefixEnv","kvEnv","durableObject"], name + ".worker");
    for (const value of [entry.packageDir,entry.targetPackageDir,entry.worker.directory]) {
      if (typeof value !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(value) ||
        value.startsWith("/") || value.split("/").includes(".."))
        fail(name + " has unsafe path");
    }
    const repoRoot = realpathSync(base);
    const packageAbs = path.resolve(base,entry.packageDir);
    if (!packageAbs.startsWith(repoRoot + path.sep) || !existsSync(packageAbs) ||
        !realpathSync(packageAbs).startsWith(repoRoot + path.sep))
      fail(name + " packageDir missing or outside repository: " + entry.packageDir);
    const dir = entry.worker.directory;
    if (deployed.has(entry.worker.deployedName)) fail("duplicate deployed Worker identity");
    deployed.add(entry.worker.deployedName);
    if (entry.worker.deployedName !== "linear-" + name + "-agent") fail(name + " has unexpected deployed Worker name");
    if (entry.runtimeContract.executable && !/^([A-Z][A-Z0-9_]*)$/.test(entry.runtimeContract.executable.binaryEnv)) fail(name + " invalid executable env");
    if (entry.executionPolicy.permissions.deployment || entry.executionPolicy.permissions.autoMerge || entry.executionPolicy.permissions.gitPush) fail(name + " cannot authorize deployment, auto merge, or git push via metadata");
    if (directories.has(dir)) fail("duplicate Worker directory: " + dir);
    directories.add(dir);
    const expectedPrefix = name.toUpperCase().replaceAll("-", "_");
    if (entry.worker.prefixEnv !== expectedPrefix + "_PREFIX" ||
      entry.worker.kvEnv !== expectedPrefix + "_KV_NAMESPACE_ID" ||
      entry.worker.config !== "wrangler.jsonc" ||
      entry.worker.durableObject !== "DELIVERY_COORDINATOR")
      fail(name + " has unexpected Worker bindings");
    if (kvBindings.has(entry.worker.kvEnv) || prefixVars.has(entry.worker.prefixEnv))
      fail("duplicate KV namespace/prefix binding");
    kvBindings.add(entry.worker.kvEnv); prefixVars.add(entry.worker.prefixEnv);
    const template = path.resolve(base,dir,entry.worker.config);
    if (!template.startsWith(repoRoot + path.sep) || !existsSync(template) ||
        !realpathSync(template).startsWith(repoRoot + path.sep))
      fail(name + " missing Worker config: " + template);
    const source = readFileSync(template,"utf8");
    const wrangler = parseWranglerJsonc(source);
    if (wrangler.name !== entry.worker.serviceTemplate)
      fail(name + " Worker service name drift: " + wrangler.name);
    const expectedKvId = "${" + entry.worker.kvEnv + "}";
    if (!Array.isArray(wrangler.kv_namespaces) || wrangler.kv_namespaces.length !== 1 ||
        wrangler.kv_namespaces[0].binding !== "LINEAR_DATA" ||
        wrangler.kv_namespaces[0].id !== expectedKvId)
      fail(name + " KV namespace binding drift");
    if (!Array.isArray(wrangler.durable_objects?.bindings) ||
        !wrangler.durable_objects.bindings.some(b =>
          b.name === entry.worker.durableObject && b.class_name === "DeliveryCoordinator"))
      fail(name + " Durable Object binding drift");
    if (!wrangler.routes?.some(r => r.custom_domain === true &&
      r.pattern === "linear-${" + entry.worker.prefixEnv + "}.${DOMAIN}"))
      fail(name + " Linear route drift");
    if (wrangler.vars?.SERVICE_NAME !== "linear-${" + entry.worker.prefixEnv + "}-agent")
      fail(name + " SERVICE_NAME drift");
  }
  if (!agents.every(id => ids.has(id))) fail("incomplete registry");
  const chatgpt = registry.agents.find(x => x.id === "chatgpt");
  const cli = registry.agents.find(x => x.id === "chatgpt-cli");
  if (chatgpt.linear.appIdentity !== cli.linear.appIdentity ||
    chatgpt.linear.credentialPrefix !== cli.linear.credentialPrefix ||
    chatgpt.worker.directory === cli.worker.directory ||
    chatgpt.worker.kvEnv === cli.worker.kvEnv)
    fail("ChatGPT review/CLI must share app credentials but not Worker or KV identity");
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const registry = JSON.parse(readFileSync(regPath,"utf8"));
    const schema = JSON.parse(readFileSync(schemaPath,"utf8"));
    validateRegistry(registry,schema);
    console.log("Validated " + registry.agents.length + " agent registry entries against Wrangler templates.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
