#!/usr/bin/env node
// Generate an untracked, deployment-specific Wrangler config from .env exports.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [agent, output] = process.argv.slice(2);
if (!/^(antigravity|chatgpt|gemini|trae|mock)$/.test(agent) || !output) throw Error("Usage: node render-wrangler.mjs <agent> <output>");
const key=agent.toUpperCase(), domain=process.env.DOMAIN;
const prefix=process.env[`${key}_PREFIX`] || agent;
if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw Error(`Invalid ${key}_PREFIX`);
const serviceName=`linear-${prefix}-agent`;
const host=`${prefix}-agent.${domain}`;
const webhookUrl=`https://linear-${prefix}.${domain}/webhook`;
const id=process.env[`${key}_KV_NAMESPACE_ID`];
if (!domain || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain)) throw Error("DOMAIN must be a valid configured domain");
if (!id || !/^[a-f0-9]{32}$/i.test(id)) throw Error(`Missing or invalid ${key}_KV_NAMESPACE_ID in .env`);
const folder=path.join(process.env.REPO_ROOT || process.cwd(), `linear-${agent}-worker`);
let config=readFileSync(path.join(folder,"wrangler.jsonc"),"utf8");
const replacements=[
  [/"id"\s*:\s*"[^"]+"/, `"id": "${id}"`],
  [/"name"\s*:\s*"[^"]+"/, `"name": "${serviceName}"`],
  [/"SERVICE_NAME"\s*:\s*"[^"]+"/, `"SERVICE_NAME": "${serviceName}"`],
  [/"LINEAR_REDIRECT_URI"\s*:\s*"[^"]+"/, `"LINEAR_REDIRECT_URI": "https://linear-${prefix}.${domain}/oauth/callback"`],
  [/"BRIDGE_URL"\s*:\s*"[^"]+"/, `"BRIDGE_URL": "https://${prefix}-agent.${domain}/jobs"`]
];
for (const [pattern,replacement] of replacements) {
  if (!pattern.test(config)) throw Error(`Missing required Wrangler field: ${pattern}`);
  config=config.replace(pattern,replacement);
}
if (process.env[`${key}_WEBHOOK_URL`] && process.env[`${key}_WEBHOOK_URL`] !== webhookUrl) throw Error(`${key}_WEBHOOK_URL must match prefix-derived ${webhookUrl}`);
if (process.env[`${key}_HOST`] && process.env[`${key}_HOST`] !== host) throw Error(`${key}_HOST must match prefix-derived ${host}`);
// Resolve the tracked template's Worker Custom Domain.
// The agent bridge Tunnel hostname is intentionally different.
const routePlaceholder = 'linear-${' + key + '_PREFIX}.${DOMAIN}';
if (!config.includes(routePlaceholder) || !config.includes('"custom_domain": true')) {
  throw new Error("Expected templated custom-domain route in wrangler.jsonc");
}
config = config.replace(routePlaceholder, `linear-${prefix}.${domain}`);
if (config.includes('${')) throw new Error('Unresolved environment template variable in generated Wrangler config');
writeFileSync(output,config,{mode:0o600,flag:"wx"});
