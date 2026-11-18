#!/usr/bin/env node
// Read-only deployment smoke check. No valid token, job, or Linear activity
// is created. Both endpoints must reach Ubuntu and reject the request.
import { pathToFileURL } from "node:url";

export const TRAE_CALLBACK_PATHS = ["/trae-activity", "/trae-complete"];
const expected = {
  "/trae-activity": { status: 400, error: "Invalid Trae workspace" },
  "/trae-complete": { status: 401, error: "Invalid completion context" },
};

export function validateTraeCallbackBase(host) {
  if (typeof host !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host)) {
    throw Error("TRAE_HOST must be a DNS hostname, without scheme, port or path");
  }
  return host;
}

export async function probeTraeCallbacks({ host, fetchImpl = fetch, timeoutMs = 9000 }) {
  const hostname = validateTraeCallbackBase(host);
  const results = [];
  for (const path of TRAE_CALLBACK_PATHS) {
    const url = `https://${hostname}${path}`;
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      body = await response.json().catch(() => null);
    }
    const wanted = expected[path];
    if (response.status !== wanted.status || body?.ok !== false || body.error !== wanted.error) {
      throw Error(`Trae route ${path} did not reach the expected Ubuntu handler: HTTP ${response.status}; expected HTTP ${wanted.status} and a specific JSON denial. Check Cloudflare WAF/Tunnel/origin configuration.`);
    }
    results.push({ path, status: response.status, outcome: "unauthenticated request rejected by Ubuntu" });
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeTraeCallbacks({ host: process.env.TRAE_HOST || `trae-agent.${process.env.DOMAIN || "revrebel.io"}` })
    .then(results => { for (const r of results) console.log(`PASS ${r.path}: HTTP ${r.status} (Ubuntu rejected unauthenticated request)`); })
    .catch(error => { console.error(`FAIL Trae callback routing: ${error.message}`); process.exitCode = 1; });
}
