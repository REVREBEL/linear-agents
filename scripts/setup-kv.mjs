#!/usr/bin/env node
// Idempotent Cloudflare KV bootstrap for one Linear agent. Called with root .env loaded.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const agents = new Set(["antigravity", "chatgpt", "gemini", "trae", "mock"]);
const agent = process.argv[2];
if (!agents.has(agent)) throw new Error("Usage: npm run setup:kv -- <antigravity|chatgpt|gemini|trae|mock>");
const key = agent.toUpperCase();
const prefix = process.env[`${key}_PREFIX`] || agent;
if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error("Invalid agent prefix");
const title = `LINEAR_${prefix.toUpperCase().replaceAll("-", "_")}_DATA`;
const envKey = `${key}_KV_NAMESPACE_ID`;
const existing = process.env[envKey] || "";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const root = process.env.REPO_ROOT || process.cwd();
const envFile = process.env.LINEAR_AGENTS_ENV_FILE || path.join(root, ".env");
if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");
if (existing && !/^[a-f0-9]{32}$/i.test(existing)) throw new Error(`Invalid ${envKey}`);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {Authorization: `Bearer ${token}`, "Content-Type":"application/json", ...(options.headers || {})},
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare KV API request failed (${response.status}): ${JSON.stringify(body.errors || [])}`);
  }
  return body;
}
const matches = [];
let page = 1;
while (true) {
  const result = await request(`${base}?page=${page}&per_page=100`);
  const entries = result.result || [];
  matches.push(...entries.filter(item => item.title === title));
  if (page >= (result.result_info?.total_pages || 1) || entries.length === 0) break;
  page++;
}
if (matches.length > 1) throw new Error(`Multiple KV namespaces are named ${title}; choose manually`);
if (existing) {
  if (!matches.length) throw new Error(`${envKey} is set, but no namespace named ${title} exists in this Cloudflare account`);
  if (matches.length && matches[0].id !== existing) throw new Error(`${envKey} disagrees with Cloudflare namespace ${title}; refusing to overwrite`);
  console.log(`${envKey} already configured. No changes made.`);
  process.exit(0);
}
let namespace = matches[0];
if (!namespace) {
  const result = await request(base, {method:"POST", body:JSON.stringify({title})});
  namespace = result.result;
  console.log(`Created KV namespace ${title}`);
} else {
  console.log(`Reusing existing KV namespace ${title}`);
}
if (!namespace?.id || !/^[a-f0-9]{32}$/i.test(namespace.id)) throw new Error("Cloudflare returned an invalid KV ID");
const original = readFileSync(envFile, "utf8");
const matchesInFile = [...original.matchAll(new RegExp(`^\\s*(?:export\\s+)?${envKey}=.*$`, "gm"))];
if (matchesInFile.length > 1) throw new Error(`Duplicate ${envKey} entries in .env; resolve manually`);
if (matchesInFile.length && !new RegExp(`^\\s*(?:export\\s+)?${envKey}=\\s*(?:["']?\\s*["']?)$`).test(matchesInFile[0][0])) {
  throw new Error(`${envKey} has a value in .env; refusing to overwrite`);
}
const line = `${envKey}="${namespace.id}"`;
const updated = matchesInFile.length
  ? original.replace(matchesInFile[0][0], line)
  : original.replace(/\n?$/, "\n") + line + "\n";
const mode = statSync(envFile).mode & 0o777;
writeFileSync(envFile, updated, {mode});
console.log(`Saved ${envKey} to ignored .env`);
