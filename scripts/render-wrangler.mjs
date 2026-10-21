#!/usr/bin/env node
// Generate an untracked, deployment-specific Wrangler config from .env exports.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [agent, output] = process.argv.slice(2);
if (!/^(antigravity|chatgpt|gemini|trae|mock)$/.test(agent) || !output) throw Error("Usage: node render-wrangler.mjs <agent> <output>");
const key=agent.toUpperCase(), domain=process.env.DOMAIN;
const id=process.env[`${key}_KV_NAMESPACE_ID`];
if (!domain || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain)) throw Error("DOMAIN must be a valid configured domain");
if (!id || !/^[a-f0-9]{32}$/i.test(id)) throw Error(`Missing or invalid ${key}_KV_NAMESPACE_ID in .env`);
const folder=path.join(process.env.REPO_ROOT || process.cwd(), `linear-${agent}-worker`);
let config=readFileSync(path.join(folder,"wrangler.jsonc"),"utf8");
const replacements=[
  [/"id"\s*:\s*"[^"]+"/, `"id": "${id}"`],
  [/"LINEAR_REDIRECT_URI"\s*:\s*"[^"]+"/, `"LINEAR_REDIRECT_URI": "https://linear-${agent}.${domain}/oauth/callback"`],
  [/"BRIDGE_URL"\s*:\s*"[^"]+"/, `"BRIDGE_URL": "https://${agent}-agent.${domain}/jobs"`]
];
for (const [pattern,replacement] of replacements) {
  if (!pattern.test(config)) throw Error(`Missing required Wrangler field: ${pattern}`);
  config=config.replace(pattern,replacement);
}
writeFileSync(output,config,{mode:0o600,flag:"wx"});
